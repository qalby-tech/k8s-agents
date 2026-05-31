package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// AgentFleetSpec defines the per-namespace AI daemon and the targets it controls.
type AgentFleetSpec struct {
	// Engine image tag suffix to deploy as the daemon (e.g. "opencode", "claude").
	Engine string `json:"engine,omitempty"`

	// ProviderCredentialRef names the Secret holding opencode auth.json.
	ProviderCredentialRef string `json:"providerCredentialRef,omitempty"`

	// TargetLabels selects pods/VMs (in this namespace) to enroll as fleet
	// targets. Pods get an sshd sidecar; GUI VMs get cua + autologin.
	TargetLabels map[string]string `json:"targetLabels,omitempty"`
}

// AgentFleetStatus is the observed state of an AgentFleet.
type AgentFleetStatus struct {
	// Targets is the number of enrolled targets.
	Targets int `json:"targets,omitempty"`
	// Ready is true when the daemon and all targets are wired up.
	Ready bool `json:"ready,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Engine",type=string,JSONPath=`.spec.engine`
// +kubebuilder:printcolumn:name="Targets",type=integer,JSONPath=`.status.targets`

// AgentFleet is one AI daemon per namespace plus its fleet of SSH/GUI targets.
type AgentFleet struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   AgentFleetSpec   `json:"spec,omitempty"`
	Status AgentFleetStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// AgentFleetList contains a list of AgentFleet.
type AgentFleetList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AgentFleet `json:"items"`
}

func init() {
	SchemeBuilder.Register(&AgentFleet{}, &AgentFleetList{})
}
