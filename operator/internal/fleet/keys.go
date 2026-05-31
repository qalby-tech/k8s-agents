// Package fleet holds helpers the operator uses to wire a daemon to its targets:
// SSH key generation and the rendering of targets.json / ssh_config / AGENTS.md.
package fleet

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"

	"golang.org/x/crypto/ssh"
)

// KeyPair is an ed25519 SSH keypair in the formats the fleet needs.
type KeyPair struct {
	// PrivatePEM is the OpenSSH private key (mounted into the daemon).
	PrivatePEM []byte
	// AuthorizedKey is the public key in authorized_keys form (pushed to targets).
	AuthorizedKey []byte
}

// GenerateSSHKeyPair creates a fresh ed25519 SSH keypair.
func GenerateSSHKeyPair() (*KeyPair, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		return nil, err
	}
	block, err := ssh.MarshalPrivateKey(priv, "k8s-agents")
	if err != nil {
		return nil, err
	}
	return &KeyPair{
		PrivatePEM:    pem.EncodeToMemory(block),
		AuthorizedKey: ssh.MarshalAuthorizedKey(sshPub),
	}, nil
}
