package availabilitylease

import (
	"errors"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// SealFrame encodes and signs a batch. Relays route the frame by
// DestinationId; the recipient verifies the signature in ReceiveFrame.
func SealFrame(batch *pb.LeaseBatch, signer Signer) (*pb.CoordinationFrame, error) {
	if batch.GetSenderId() == "" || batch.GetDestinationId() == "" {
		return nil, errors.New("lease batch needs sender and destination")
	}
	payload, err := proto.Marshal(batch)
	if err != nil {
		return nil, err
	}
	signature, err := signer.Sign(frameMessage(payload))
	if err != nil {
		return nil, err
	}
	return &pb.CoordinationFrame{
		DestinationId: batch.GetDestinationId(), SenderId: batch.GetSenderId(),
		Payload: payload, Signature: signature,
	}, nil
}
