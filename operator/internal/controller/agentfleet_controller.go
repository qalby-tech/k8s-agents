package controller

import (
	"context"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	agentsv1alpha1 "github.com/qalby-tech/k8s-agents/operator/api/v1alpha1"
	"github.com/qalby-tech/k8s-agents/operator/internal/fleet"
)

// imageRepo is the single Docker Hub repo all images publish to.
const imageRepo = "kamasalyamov/agents"

// AgentFleetReconciler reconciles an AgentFleet object.
type AgentFleetReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

func daemonName(f *agentsv1alpha1.AgentFleet) string    { return "agent-daemon-" + f.Name }
func keySecretName(f *agentsv1alpha1.AgentFleet) string { return "agent-ssh-" + f.Name }
func configMapName(f *agentsv1alpha1.AgentFleet) string { return "agent-fleet-" + f.Name }

func daemonLabels(f *agentsv1alpha1.AgentFleet) map[string]string {
	return map[string]string{"app": "agent-daemon", "agents.livellm.io/fleet": f.Name}
}

// +kubebuilder:rbac:groups=agents.livellm.io,resources=agentfleets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=agents.livellm.io,resources=agentfleets/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=secrets;configmaps;pods,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=networking.k8s.io,resources=networkpolicies,verbs=get;list;watch;create;update;patch;delete

// Reconcile drives an AgentFleet toward its desired state.
func (r *AgentFleetReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	l := log.FromContext(ctx)

	var f agentsv1alpha1.AgentFleet
	if err := r.Get(ctx, req.NamespacedName, &f); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// 1. Per-fleet SSH keypair (generated once, reused thereafter).
	if err := r.ensureKeySecret(ctx, &f); err != nil {
		return ctrl.Result{}, fmt.Errorf("key secret: %w", err)
	}

	// 2. Discover targets (pods selected by spec.targetLabels in this namespace).
	targets, err := r.discoverTargets(ctx, &f)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("discover targets: %w", err)
	}

	// 3. Rendered fleet config (targets.json / ssh config / known_hosts / AGENTS.md).
	if err := r.ensureConfigMap(ctx, &f, targets); err != nil {
		return ctrl.Result{}, fmt.Errorf("config map: %w", err)
	}

	// 4. The AI daemon Deployment.
	if err := r.ensureDeployment(ctx, &f); err != nil {
		return ctrl.Result{}, fmt.Errorf("deployment: %w", err)
	}

	// 5. NetworkPolicy: targets accept SSH only from this fleet's daemon.
	if err := r.ensureNetworkPolicy(ctx, &f); err != nil {
		return ctrl.Result{}, fmt.Errorf("network policy: %w", err)
	}

	// 6. Status.
	f.Status.Targets = len(targets)
	f.Status.Ready = true
	if err := r.Status().Update(ctx, &f); err != nil {
		return ctrl.Result{}, err
	}

	l.Info("reconciled AgentFleet", "fleet", f.Name, "targets", len(targets))
	// Periodic resync to pick up new/changed target pods (TODO: replace with a pod watch).
	return ctrl.Result{RequeueAfter: time.Minute}, nil
}

func (r *AgentFleetReconciler) ensureKeySecret(ctx context.Context, f *agentsv1alpha1.AgentFleet) error {
	var sec corev1.Secret
	err := r.Get(ctx, types.NamespacedName{Namespace: f.Namespace, Name: keySecretName(f)}, &sec)
	if err == nil {
		return nil // exists; never regenerate
	}
	if !apierrors.IsNotFound(err) {
		return err
	}
	kp, err := fleet.GenerateSSHKeyPair()
	if err != nil {
		return err
	}
	sec = corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: keySecretName(f), Namespace: f.Namespace},
		Type:       corev1.SecretTypeOpaque,
		Data: map[string][]byte{
			"id_ed25519_fleet":     kp.PrivatePEM,
			"id_ed25519_fleet.pub": kp.AuthorizedKey,
			"authorized_keys":      kp.AuthorizedKey,
		},
	}
	if err := controllerutil.SetControllerReference(f, &sec, r.Scheme); err != nil {
		return err
	}
	return r.Create(ctx, &sec)
}

func (r *AgentFleetReconciler) discoverTargets(ctx context.Context, f *agentsv1alpha1.AgentFleet) ([]fleet.Target, error) {
	if len(f.Spec.TargetLabels) == 0 {
		return nil, nil
	}
	var pods corev1.PodList
	if err := r.List(ctx, &pods,
		client.InNamespace(f.Namespace),
		client.MatchingLabels(f.Spec.TargetLabels)); err != nil {
		return nil, err
	}
	var ts []fleet.Target
	for i := range pods.Items {
		p := &pods.Items[i]
		if p.DeletionTimestamp != nil {
			continue
		}
		ts = append(ts, fleet.TargetFromPod(p))
	}
	return ts, nil
}

func (r *AgentFleetReconciler) ensureConfigMap(ctx context.Context, f *agentsv1alpha1.AgentFleet, targets []fleet.Target) error {
	targetsJSON, err := fleet.RenderTargetsJSON(targets)
	if err != nil {
		return err
	}
	cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: configMapName(f), Namespace: f.Namespace}}
	_, err = controllerutil.CreateOrUpdate(ctx, r.Client, cm, func() error {
		cm.Labels = daemonLabels(f)
		cm.Data = map[string]string{
			"targets.json": targetsJSON,
			"config":       fleet.RenderSSHConfig(targets),
			"known_hosts":  "", // TODO: operator-collected host keys for pinning
			"AGENTS.md":    fleet.RenderAgentsMD(targets),
		}
		return controllerutil.SetControllerReference(f, cm, r.Scheme)
	})
	return err
}

func (r *AgentFleetReconciler) ensureDeployment(ctx context.Context, f *agentsv1alpha1.AgentFleet) error {
	dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: daemonName(f), Namespace: f.Namespace}}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, dep, func() error {
		applyDeploymentSpec(f, dep)
		return controllerutil.SetControllerReference(f, dep, r.Scheme)
	})
	return err
}

func applyDeploymentSpec(f *agentsv1alpha1.AgentFleet, dep *appsv1.Deployment) {
	labels := daemonLabels(f)
	engine := f.Spec.Engine
	if engine == "" {
		engine = "opencode"
	}
	image := fmt.Sprintf("%s:%s-latest", imageRepo, engine)

	volumes := []corev1.Volume{
		{Name: "ssh-key", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
			SecretName:  keySecretName(f),
			DefaultMode: ptr.To(int32(0o600)),
		}}},
		{Name: "fleet-config", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{
			LocalObjectReference: corev1.LocalObjectReference{Name: configMapName(f)},
		}}},
		{Name: "ssh-home", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
	}

	initMounts := []corev1.VolumeMount{
		{Name: "ssh-key", MountPath: "/etc/fleet-ssh", ReadOnly: true},
		{Name: "fleet-config", MountPath: "/etc/fleet-cfg", ReadOnly: true},
		{Name: "ssh-home", MountPath: "/root/.ssh"},
	}
	engineMounts := []corev1.VolumeMount{
		{Name: "ssh-home", MountPath: "/root/.ssh"},
		{Name: "fleet-config", MountPath: "/etc/fleet/targets.json", SubPath: "targets.json", ReadOnly: true},
		{Name: "fleet-config", MountPath: "/workspace/AGENTS.md", SubPath: "AGENTS.md", ReadOnly: true},
	}

	if f.Spec.ProviderCredentialRef != "" {
		volumes = append(volumes, corev1.Volume{Name: "auth", VolumeSource: corev1.VolumeSource{
			Secret: &corev1.SecretVolumeSource{SecretName: f.Spec.ProviderCredentialRef},
		}})
		engineMounts = append(engineMounts, corev1.VolumeMount{
			Name: "auth", MountPath: "/root/.local/share/opencode/auth.json", SubPath: "auth.json", ReadOnly: true,
		})
	}

	dep.Labels = labels
	dep.Spec = appsv1.DeploymentSpec{
		Replicas: ptr.To(int32(1)),
		Selector: &metav1.LabelSelector{MatchLabels: labels},
		Template: corev1.PodTemplateSpec{
			ObjectMeta: metav1.ObjectMeta{Labels: labels},
			Spec: corev1.PodSpec{
				InitContainers: []corev1.Container{{
					Name:  "ssh-setup",
					Image: "busybox:1.36",
					// Lay out ~/.ssh from the mounted key + rendered config at correct perms.
					Command: []string{"sh", "-c",
						"install -m700 -d /root/.ssh && " +
							"install -m600 /etc/fleet-ssh/id_ed25519_fleet /root/.ssh/id_ed25519_fleet && " +
							"install -m600 /etc/fleet-cfg/config /root/.ssh/config && " +
							"install -m600 /etc/fleet-cfg/known_hosts /root/.ssh/known_hosts.fleet && " +
							"mkdir -m700 -p /root/.ssh/cm"},
					VolumeMounts: initMounts,
				}},
				Containers: []corev1.Container{{
					Name:  "engine",
					Image: image,
					Ports: []corev1.ContainerPort{{ContainerPort: 4096, Name: "http"}},
					Env: []corev1.EnvVar{
						{Name: "HOME", Value: "/root"},
						{Name: "OPENCODE_DATA", Value: "/root/.local/share/opencode"},
						{Name: "FLEET_TARGETS", Value: "/etc/fleet/targets.json"},
					},
					VolumeMounts: engineMounts,
				}},
				Volumes: volumes,
			},
		},
	}
}

func (r *AgentFleetReconciler) ensureNetworkPolicy(ctx context.Context, f *agentsv1alpha1.AgentFleet) error {
	if len(f.Spec.TargetLabels) == 0 {
		return nil
	}
	np := &networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: configMapName(f), Namespace: f.Namespace}}
	tcp := corev1.ProtocolTCP
	sshPort := intstr.FromInt(22)
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, np, func() error {
		np.Labels = daemonLabels(f)
		np.Spec = networkingv1.NetworkPolicySpec{
			// Applies to the target pods…
			PodSelector: metav1.LabelSelector{MatchLabels: f.Spec.TargetLabels},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			// …which accept SSH only from this fleet's daemon.
			Ingress: []networkingv1.NetworkPolicyIngressRule{{
				From: []networkingv1.NetworkPolicyPeer{{
					PodSelector: &metav1.LabelSelector{MatchLabels: daemonLabels(f)},
				}},
				Ports: []networkingv1.NetworkPolicyPort{{Protocol: &tcp, Port: &sshPort}},
			}},
		}
		return controllerutil.SetControllerReference(f, np, r.Scheme)
	})
	return err
}

// SetupWithManager wires the reconciler and the resources it owns.
func (r *AgentFleetReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&agentsv1alpha1.AgentFleet{}).
		Owns(&corev1.Secret{}).
		Owns(&corev1.ConfigMap{}).
		Owns(&appsv1.Deployment{}).
		Owns(&networkingv1.NetworkPolicy{}).
		Complete(r)
}
