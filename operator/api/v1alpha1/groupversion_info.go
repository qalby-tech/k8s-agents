// Package v1alpha1 contains the AgentFleet API for the k8s-agents operator.
// +kubebuilder:object:generate=true
// +groupName=agents.livellm.io
package v1alpha1

import (
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

var (
	// GroupVersion is the group/version for this API. Mirrors the platform's
	// livellm.io domain (cf. livellm.io/v1alpha1 Controller).
	GroupVersion = schema.GroupVersion{Group: "agents.livellm.io", Version: "v1alpha1"}

	// SchemeBuilder registers the API types with a runtime.Scheme.
	SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}

	// AddToScheme adds this API to a scheme.
	AddToScheme = SchemeBuilder.AddToScheme
)
