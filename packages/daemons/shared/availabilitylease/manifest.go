package availabilitylease

import (
	"errors"
	"fmt"
	"sort"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// Manifest is a verified per-policy lease manifest (D4).
type Manifest struct {
	block      *pb.LeaseSignedBlock
	PolicyID   string
	Version    uint64
	Epoch      uint64
	Available  bool
	Slots      uint32
	Closed     bool
	Candidates []string
	rank       map[string]int
	keys       map[string][]byte
	// BootstrapID and Bootstrap name the reserved initial holder per slot (A5).
	BootstrapID uint64
	Bootstrap   map[uint32]string
}

func parseManifest(block *pb.LeaseSignedBlock) (*Manifest, error) {
	if block.GetKind() != pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST {
		return nil, errors.New("lease block is not a manifest")
	}
	value := &pb.LeaseManifest{}
	if err := proto.Unmarshal(block.GetPayload(), value); err != nil {
		return nil, fmt.Errorf("decode lease manifest: %w", err)
	}
	if value.GetSchemaVersion() != 1 || value.GetPolicyId() == "" || value.GetManifestVersion() == 0 {
		return nil, errors.New("lease manifest scope is invalid")
	}
	if term := value.GetLeaseTermMs(); term != 0 && int64(term) != LeaseTerm.Milliseconds() {
		return nil, fmt.Errorf("lease manifest term %dms differs from the fixed %s", term, LeaseTerm)
	}
	mode := value.GetMode()
	if mode != pb.LeasePolicyMode_LEASE_POLICY_MODE_FAILOVER && mode != pb.LeasePolicyMode_LEASE_POLICY_MODE_REPLICATED {
		return nil, errors.New("lease manifest mode is invalid")
	}
	partition := value.GetPartitionMode()
	if partition != pb.LeasePartitionMode_LEASE_PARTITION_MODE_STRICT && partition != pb.LeasePartitionMode_LEASE_PARTITION_MODE_AVAILABLE {
		return nil, errors.New("lease manifest partition mode is invalid")
	}
	slots := value.GetSlots()
	if slots == 0 || (mode == pb.LeasePolicyMode_LEASE_POLICY_MODE_FAILOVER && slots != 1) || slots > 32 {
		return nil, errors.New("lease manifest slot count is invalid")
	}
	manifest := &Manifest{
		block: block, PolicyID: value.GetPolicyId(), Version: value.GetManifestVersion(), Epoch: value.GetEpoch(),
		Available: partition == pb.LeasePartitionMode_LEASE_PARTITION_MODE_AVAILABLE,
		Slots:     slots, Closed: value.GetClosed(),
		rank: map[string]int{}, keys: map[string][]byte{},
		BootstrapID: value.GetBootstrapId(), Bootstrap: map[uint32]string{},
	}
	for _, candidate := range value.GetCandidates() {
		if candidate.GetId() == "" || len(candidate.GetPublicKey()) == 0 {
			return nil, errors.New("lease manifest candidate is invalid")
		}
		if _, exists := manifest.rank[candidate.GetId()]; exists {
			return nil, fmt.Errorf("duplicate lease candidate %q", candidate.GetId())
		}
		manifest.rank[candidate.GetId()] = len(manifest.Candidates)
		manifest.Candidates = append(manifest.Candidates, candidate.GetId())
		manifest.keys[candidate.GetId()] = append([]byte(nil), candidate.GetPublicKey()...)
	}
	if len(manifest.Candidates) == 0 && !manifest.Closed {
		return nil, errors.New("lease manifest has no candidates")
	}
	for _, entry := range value.GetBootstrap() {
		if manifest.BootstrapID == 0 || entry.GetSlot() >= slots {
			return nil, errors.New("lease manifest bootstrap is invalid")
		}
		if _, ok := manifest.rank[entry.GetHolderId()]; !ok {
			return nil, errors.New("lease manifest bootstrap holder is not a candidate")
		}
		manifest.Bootstrap[entry.GetSlot()] = entry.GetHolderId()
	}
	return manifest, nil
}

func (m *Manifest) isCandidate(id string) bool {
	_, ok := m.rank[id]
	return ok
}

// VoterConfig is a verified cluster voter set. Two quorum sets mean a
// joint-consensus transition (D2, A4): every quorum needs a majority of each.
type VoterConfig struct {
	block   *pb.LeaseSignedBlock
	Epoch   uint64
	members map[string]*pb.LeaseMember
	sets    [][]string
	voters  map[string]bool
	// memberIDs and relayIDs are sorted so message fan-out is deterministic.
	memberIDs []string
	relayIDs  []string
	voterIDs  []string
}

func parseVoterConfig(block *pb.LeaseSignedBlock) (*VoterConfig, error) {
	if block.GetKind() != pb.LeaseBlockKind_LEASE_BLOCK_KIND_VOTER_CONFIG {
		return nil, errors.New("lease block is not a voter config")
	}
	value := &pb.LeaseVoterConfig{}
	if err := proto.Unmarshal(block.GetPayload(), value); err != nil {
		return nil, fmt.Errorf("decode lease voter config: %w", err)
	}
	if value.GetSchemaVersion() != 1 || value.GetEpoch() == 0 {
		return nil, errors.New("lease voter config scope is invalid")
	}
	config := &VoterConfig{block: block, Epoch: value.GetEpoch(), members: map[string]*pb.LeaseMember{}, voters: map[string]bool{}}
	for _, member := range value.GetMembers() {
		if member.GetId() == "" || len(member.GetPublicKey()) == 0 {
			return nil, errors.New("lease voter config member is invalid")
		}
		if _, exists := config.members[member.GetId()]; exists {
			return nil, fmt.Errorf("duplicate lease member %q", member.GetId())
		}
		config.members[member.GetId()] = member
		config.memberIDs = append(config.memberIDs, member.GetId())
		if member.GetRole() == pb.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY {
			config.relayIDs = append(config.relayIDs, member.GetId())
		}
	}
	if n := len(value.GetQuorumSets()); n != 1 && n != 2 {
		return nil, errors.New("lease voter config needs one quorum set, or two while joint")
	}
	for _, set := range value.GetQuorumSets() {
		seen := map[string]bool{}
		for _, id := range set.GetVoterIds() {
			if config.members[id] == nil || seen[id] {
				return nil, fmt.Errorf("lease quorum set voter %q is invalid", id)
			}
			seen[id] = true
			config.voters[id] = true
		}
		if len(seen) == 0 {
			return nil, errors.New("lease quorum set is empty")
		}
		config.sets = append(config.sets, append([]string(nil), set.GetVoterIds()...))
	}
	sort.Strings(config.memberIDs)
	sort.Strings(config.relayIDs)
	config.voterIDs = sortedKeys(config.voters)
	return config, nil
}

// quorum reports whether ids hold a majority of every quorum set.
func (c *VoterConfig) quorum(ids map[string]bool) bool {
	for _, set := range c.sets {
		count := 0
		for _, id := range set {
			if ids[id] {
				count++
			}
		}
		if count*2 <= len(set) {
			return false
		}
	}
	return true
}

// quorumImpossible reports whether refused ids make a quorum unreachable.
func (c *VoterConfig) quorumImpossible(refused map[string]bool) bool {
	for _, set := range c.sets {
		count := 0
		for _, id := range set {
			if refused[id] {
				count++
			}
		}
		if count*2 >= len(set) {
			return true
		}
	}
	return false
}

func (c *VoterConfig) isVoter(id string) bool { return c.voters[id] }

func (c *VoterConfig) isRelay(id string) bool {
	member := c.members[id]
	return member != nil && member.GetRole() == pb.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY
}

func (c *VoterConfig) publicKey(id string) ([]byte, bool) {
	member := c.members[id]
	if member == nil {
		return nil, false
	}
	return member.GetPublicKey(), true
}
