package availabilitylease

import (
	"errors"
	"fmt"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// ReceiveFrame verifies and processes one frame addressed to this node.
func (n *Node) ReceiveFrame(frame *pb.CoordinationFrame) error {
	batch := &pb.LeaseBatch{}
	if err := proto.Unmarshal(frame.GetPayload(), batch); err != nil {
		return fmt.Errorf("decode lease batch: %w", err)
	}
	if batch.GetSenderId() == "" || batch.GetSenderId() != frame.GetSenderId() || batch.GetDestinationId() != n.id {
		return errors.New("lease frame routing does not match its payload")
	}
	var verr error
	n.run(func(now time.Duration) {
		// Blocks are signed by the policy key, so adopting them before the
		// frame signature check is safe and lets a new candidate's first
		// frame verify against the manifest it carries.
		n.adoptForwarded(batch, now)
		publicKey, ok := n.identityKey(batch.GetSenderId())
		if !ok {
			n.reportUnknownSender(batch)
			verr = ErrUnknownSender
			return
		}
		if !n.verifier.Verify(publicKey, frameMessage(frame.GetPayload()), frame.GetSignature()) {
			verr = fmt.Errorf("lease frame from %q has an invalid signature", batch.GetSenderId())
			return
		}
		n.receiveLocked(batch, now)
	})
	return verr
}

// ErrUnknownSender means the frame's sender is in no config or manifest this
// node holds; the frame is dropped and the sender is told this node lags.
var ErrUnknownSender = errors.New("lease frame from an unknown sender")

// receive processes a batch without signature checks (simulator path). It
// still drops frames from unknown senders like ReceiveFrame.
func (n *Node) receive(batch *pb.LeaseBatch) error {
	var err error
	n.run(func(now time.Duration) {
		n.adoptForwarded(batch, now)
		if _, ok := n.identityKey(batch.GetSenderId()); !ok {
			n.reportUnknownSender(batch)
			err = ErrUnknownSender
			return
		}
		n.receiveLocked(batch, now)
	})
	return err
}

// reportUnknownSender answers the claimed sender with bare statuses for the
// keys it mentioned, so a genuine peer forwards its blocks (A4). Statuses
// carry nothing beyond this node's epoch and manifest versions.
func (n *Node) reportUnknownSender(batch *pb.LeaseBatch) {
	from := batch.GetSenderId()
	if from == "" || from == n.id {
		return
	}
	config := n.currentConfig()
	reported := map[Key]bool{}
	for _, item := range batch.GetItems() {
		key, ok := keyFromProto(itemKey(item))
		if !ok || reported[key] {
			continue
		}
		reported[key] = true
		status := &pb.LeaseStatus{Key: key.proto()}
		if config != nil {
			status.Epoch = config.Epoch
		}
		if manifest := n.manifests[key.PolicyID]; manifest != nil {
			status.ManifestVersion = manifest.Version
		}
		n.queue(from, &pb.LeaseItem{Body: &pb.LeaseItem_Status{Status: status}})
	}
}

func itemKey(item *pb.LeaseItem) *pb.LeaseKey {
	switch body := item.GetBody().(type) {
	case *pb.LeaseItem_Prepare:
		return body.Prepare.GetKey()
	case *pb.LeaseItem_Propose:
		return body.Propose.GetKey()
	case *pb.LeaseItem_Commit:
		return body.Commit.GetKey()
	case *pb.LeaseItem_Release:
		return body.Release.GetKey()
	case *pb.LeaseItem_Query:
		if keys := body.Query.GetKeys(); len(keys) > 0 {
			return keys[0]
		}
	}
	return nil
}

// attachBlocks forwards the config, the policy manifest and the key chain
// with the next batch to dest.
func (n *Node) attachBlocks(dest, policyID string) {
	if dest == n.id {
		return
	}
	set := n.attach[dest]
	if set == nil {
		set = map[string]bool{}
		n.attach[dest] = set
	}
	set[policyID] = true
}

type forwardMark struct{ epoch, version uint64 }

// reportLag answers a commit for a manifest or epoch this node does not have
// with a bare status, so the sender forwards its blocks (A4).
func (n *Node) reportLag(from string, commit *pb.LeaseCommit) {
	key, ok := keyFromProto(commit.GetKey())
	if !ok || from == n.id {
		return
	}
	manifest, config := n.manifests[key.PolicyID], n.currentConfig()
	if manifest != nil && manifest.Version >= commit.GetManifestVersion() && config != nil && config.Epoch >= commit.GetEpoch() {
		return
	}
	status := &pb.LeaseStatus{Key: key.proto()}
	if config != nil {
		status.Epoch = config.Epoch
	}
	if manifest != nil {
		status.ManifestVersion = manifest.Version
	}
	n.queue(from, &pb.LeaseItem{Body: &pb.LeaseItem_Status{Status: status}})
}

// forwardOnce attaches our config, the policy manifest and the key chain the
// first time we address dest after adopting a newer version, so lagging
// peers adopt it from the frame instead of NACKing (A4, A14).
func (n *Node) forwardOnce(dest, policyID string) {
	manifest, config := n.manifests[policyID], n.currentConfig()
	if manifest == nil || config == nil || dest == n.id {
		return
	}
	mark := forwardMark{epoch: config.Epoch, version: manifest.Version}
	name := dest + "\x00" + policyID
	if n.forwarded[name] == mark {
		return
	}
	n.forwarded[name] = mark
	n.attachBlocks(dest, policyID)
}
