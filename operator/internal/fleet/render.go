package fleet

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
)

// Annotations on a target pod/VM that classify it for the fleet.
const (
	KindAnnotation = "agents.livellm.io/kind"     // "terminal" (default) | "gui"
	OSAnnotation   = "agents.livellm.io/os"       // "linux" (default) | "windows"
	UserAnnotation = "agents.livellm.io/ssh-user" // ssh login user (default "agent")
)

// Paths the daemon mounts use (kept absolute so ssh_config is unambiguous).
const (
	IdentityPath   = "/root/.ssh/id_ed25519_fleet"
	KnownHostsPath = "/root/.ssh/known_hosts.fleet"
)

// Target is one fleet member as the daemon's `fleet` wrapper sees it.
type Target struct {
	Name string `json:"name"`
	Host string `json:"-"` // ssh HostName; not in targets.json (lives in ssh_config)
	User string `json:"-"`
	Kind string `json:"kind"` // terminal | gui
	OS   string `json:"os"`   // linux | windows
}

// TargetFromPod builds a Target from a selected pod and its annotations.
func TargetFromPod(p *corev1.Pod) Target {
	kind := p.Annotations[KindAnnotation]
	if kind == "" {
		kind = "terminal"
	}
	osName := p.Annotations[OSAnnotation]
	if osName == "" {
		osName = "linux"
	}
	user := p.Annotations[UserAnnotation]
	if user == "" {
		user = "agent"
	}
	return Target{Name: p.Name, Host: p.Status.PodIP, User: user, Kind: kind, OS: osName}
}

func sortTargets(ts []Target) {
	sort.Slice(ts, func(i, j int) bool { return ts[i].Name < ts[j].Name })
}

// RenderTargetsJSON produces /etc/fleet/targets.json (the wrapper's manifest).
func RenderTargetsJSON(ts []Target) (string, error) {
	sortTargets(ts)
	b, err := json.MarshalIndent(ts, "", "  ")
	if err != nil {
		return "", err
	}
	return string(b) + "\n", nil
}

// RenderSSHConfig produces ~/.ssh/config: a global multiplexing/known-hosts block
// plus one Host alias per target.
func RenderSSHConfig(ts []Target) string {
	sortTargets(ts)
	var b strings.Builder
	fmt.Fprintf(&b, `Host *
  ControlMaster auto
  ControlPath /root/.ssh/cm/%%r@%%h:%%p
  ControlPersist 10m
  ServerAliveInterval 15
  ServerAliveCountMax 3
  StrictHostKeyChecking accept-new
  UserKnownHostsFile %s
  IdentityFile %s
  IdentitiesOnly yes
  ConnectTimeout 10

`, KnownHostsPath, IdentityPath)
	for _, t := range ts {
		if t.Host == "" {
			continue // pod has no IP yet; skip until it does
		}
		fmt.Fprintf(&b, "Host %s\n  HostName %s\n  User %s\n\n", t.Name, t.Host, t.User)
	}
	return b.String()
}

const agentsHeader = "# Your fleet\n\n" +
	"You control a fleet of remote machines via the `fleet` command (run it through\n" +
	"your shell tool). Shell and GUI both go over SSH — there are no other endpoints.\n\n" +
	"## Commands\n" +
	"```\n" +
	"fleet run  <name> <cmd...>          # shell on a terminal/gui target\n" +
	"fleet push <name> <local> <remote>  # copy a file up\n" +
	"fleet screenshot <name> <out.png>   # GUI: capture, then VIEW the file\n" +
	"fleet gui <name> click  <x> <y>     # GUI: click (also rclick/dclick/move)\n" +
	"fleet gui <name> type  \"text\"       # GUI: type text\n" +
	"fleet gui <name> key   <keyname>    # GUI: press a key (Return, Tab, ...)\n" +
	"fleet gui <name> hotkey ctrl l      # GUI: key combo\n" +
	"```\n" +
	"GUI loop: **screenshot → read it → act → screenshot to confirm.** Coordinates are\n" +
	"screen pixels (top-left origin). Always screenshot after an action to verify.\n\n"

// RenderAgentsMD produces /workspace/AGENTS.md: the static usage plus a live table
// of this fleet's targets.
func RenderAgentsMD(ts []Target) string {
	sortTargets(ts)
	var b strings.Builder
	b.WriteString(agentsHeader)
	b.WriteString("## Targets\n\n| name | kind | os |\n|------|------|----|\n")
	if len(ts) == 0 {
		b.WriteString("| _(none enrolled yet)_ | | |\n")
	}
	for _, t := range ts {
		fmt.Fprintf(&b, "| %s | %s | %s |\n", t.Name, t.Kind, t.OS)
	}
	return b.String()
}
