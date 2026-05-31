package controller

import (
	"context"

	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	agentsv1alpha1 "github.com/qalby-tech/k8s-agents/operator/api/v1alpha1"
)

// AgentFleetReconciler reconciles an AgentFleet object.
type AgentFleetReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=agents.livellm.io,resources=agentfleets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=agents.livellm.io,resources=agentfleets/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=secrets;pods,verbs=get;list;watch;create;update;patch;delete

// Reconcile is the control loop for AgentFleet.
func (r *AgentFleetReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	l := log.FromContext(ctx)

	// TODO(phase-6): the real reconcile —
	//   1. ensure per-ns SSH keypair Secret (agent-ssh-<ns>)
	//   2. ensure the AI daemon Deployment (engine image + mounts)
	//   3. enroll targets selected by spec.targetLabels:
	//        pod  -> inject sshd sidecar + daemon pubkey to authorized_keys
	//        VM   -> cua + autologin + pubkey via cloud-init/sysprep
	//   4. collect target host keys -> pin in daemon known_hosts
	//   5. render targets.json / ssh_config / AGENTS.md ConfigMap
	//   6. NetworkPolicy daemon -> targets :22 only
	l.Info("reconciling AgentFleet (skeleton no-op)", "fleet", req.NamespacedName)
	return ctrl.Result{}, nil
}

// SetupWithManager wires the reconciler to the manager.
func (r *AgentFleetReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&agentsv1alpha1.AgentFleet{}).
		Complete(r)
}
