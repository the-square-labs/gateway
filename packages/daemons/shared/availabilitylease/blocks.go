package availabilitylease

import (
	"bytes"
	"errors"
	"fmt"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// configHistory is how many voter configs are kept to verify commits that
// were formed under an earlier epoch.
const configHistory = 4

// TrustPolicyKey trusts a Gateway policy signing key received over an
// authenticated channel: the daemon CommandStream or the relay's verified
// policy envelope (A4).
func (n *Node) TrustPolicyKey(id string, publicKey []byte) error {
	var err error
	n.run(func(time.Duration) {
		var changed bool
		changed, err = n.chain.trust(id, publicKey)
		if changed {
			n.dirtyOther[recordKeyChain] = n.chain.encode()
		}
	})
	return err
}

// AdoptKeyRotation adds a key introduced by a trusted key (A14).
func (n *Node) AdoptKeyRotation(link *pb.LeasePolicyKeyRotation) error {
	var err error
	n.run(func(time.Duration) {
		var changed bool
		changed, err = n.chain.adopt(link)
		if changed {
			n.persistChain()
		}
	})
	return err
}

// AdoptVoterConfig adopts a newer signed voter config. It returns true when
// the config was new; callers ack only after this returns (A4 persisted ack).
func (n *Node) AdoptVoterConfig(block *pb.LeaseSignedBlock) (bool, error) {
	return n.adoptPublic(block, pb.LeaseBlockKind_LEASE_BLOCK_KIND_VOTER_CONFIG)
}

// AdoptManifest adopts a newer signed policy manifest.
func (n *Node) AdoptManifest(block *pb.LeaseSignedBlock) (bool, error) {
	return n.adoptPublic(block, pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST)
}

func (n *Node) adoptPublic(block *pb.LeaseSignedBlock, kind pb.LeaseBlockKind) (bool, error) {
	if block.GetKind() != kind {
		return false, errors.New("lease block kind mismatch")
	}
	var changed bool
	var err error
	n.run(func(now time.Duration) { changed, err = n.adoptBlock(block, now) })
	return changed, err
}

// SetCandidateReady marks whether this node may acquire keys of a policy:
// its standby is prepared and its watchdog heartbeat is fresh (A12.4).
func (n *Node) SetCandidateReady(policyID string, ready bool) {
	n.run(func(time.Duration) { n.ready[policyID] = ready })
}

// LeaseMode reports whether this node holds a lease manifest for the policy
// that is not lease-closed. While true the daemon refuses backend start and
// serve commands for the policy unless it holds the lease (A5 gate).
func (n *Node) LeaseMode(policyID string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	manifest := n.manifests[policyID]
	return manifest != nil && !manifest.Closed
}

// ManifestVersion returns the adopted manifest version for a policy.
func (n *Node) ManifestVersion(policyID string) uint64 {
	n.mu.Lock()
	defer n.mu.Unlock()
	if manifest := n.manifests[policyID]; manifest != nil {
		return manifest.Version
	}
	return 0
}

// Epoch returns the adopted voter config epoch.
func (n *Node) Epoch() uint64 {
	n.mu.Lock()
	defer n.mu.Unlock()
	if config := n.currentConfig(); config != nil {
		return config.Epoch
	}
	return 0
}

// TrustsPolicyKey reports whether a policy key is trusted (Gateway acks, A14).
func (n *Node) TrustsPolicyKey(id string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	_, ok := n.chain.lookup(id)
	return ok
}

func (n *Node) persistChain() {
	n.dirtyOther[recordKeyChain] = n.chain.encode()
	for id, link := range n.chain.links {
		data, _ := proto.Marshal(link)
		n.dirtyOther[prefixLink+id] = data
	}
}

// adoptForwarded applies rotation links and blocks carried by a batch.
func (n *Node) adoptForwarded(batch *pb.LeaseBatch, now time.Duration) {
	if len(batch.GetKeyRotations()) > 0 && n.chain.adoptAll(batch.GetKeyRotations()) {
		n.persistChain()
	}
	for _, block := range batch.GetBlocks() {
		if _, err := n.adoptBlock(block, now); err != nil {
			n.logf("forwarded lease block rejected: %v", err)
		}
	}
}

func (n *Node) adoptBlock(block *pb.LeaseSignedBlock, now time.Duration) (bool, error) {
	data, _ := proto.Marshal(block)
	switch block.GetKind() {
	case pb.LeaseBlockKind_LEASE_BLOCK_KIND_VOTER_CONFIG:
		config, err := parseVoterConfig(block)
		if err != nil {
			return false, err
		}
		if current := n.currentConfig(); current != nil && config.Epoch <= current.Epoch {
			if config.Epoch == current.Epoch && n.resigned(current.block, block, domainVoterConfig) {
				current.block = block
				n.dirtyOther[fmt.Sprintf("%s%020d", prefixConfig, config.Epoch)] = data
				return true, nil
			}
			return false, nil
		}
		if err := n.chain.verifyBlock(block, domainVoterConfig); err != nil {
			return false, err
		}
		n.configs = append(n.configs, config)
		n.dirtyOther[fmt.Sprintf("%s%020d", prefixConfig, config.Epoch)] = data
		for len(n.configs) > configHistory {
			n.deletes = append(n.deletes, fmt.Sprintf("%s%020d", prefixConfig, n.configs[0].Epoch))
			n.configs = n.configs[1:]
		}
		return true, nil
	case pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST:
		manifest, err := parseManifest(block)
		if err != nil {
			return false, err
		}
		if current := n.manifests[manifest.PolicyID]; current != nil && manifest.Version <= current.Version {
			if manifest.Version == current.Version && n.resigned(current.block, block, domainManifest) {
				current.block = block
				n.dirtyOther[prefixManifest+manifest.PolicyID] = data
				return true, nil
			}
			return false, nil
		}
		if err := n.chain.verifyBlock(block, domainManifest); err != nil {
			return false, err
		}
		previous := n.manifests[manifest.PolicyID]
		n.manifests[manifest.PolicyID] = manifest
		n.dirtyOther[prefixManifest+manifest.PolicyID] = data
		n.onManifestChanged(previous, manifest, now)
		return true, nil
	}
	return false, errors.New("unknown lease block kind")
}

// resigned reports whether next carries the same payload as current signed by
// a later key of the chain. The Gateway re-signs the current blocks after a
// rotation so peers that only trust newer keys can verify forwarded blocks.
func (n *Node) resigned(current, next *pb.LeaseSignedBlock, domain string) bool {
	if current.GetSigningKeyId() == next.GetSigningKeyId() || !bytes.Equal(current.GetPayload(), next.GetPayload()) {
		return false
	}
	if n.chain.index(next.GetSigningKeyId()) <= n.chain.index(current.GetSigningKeyId()) {
		return false
	}
	return n.chain.verifyBlock(next, domain) == nil
}
