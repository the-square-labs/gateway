//go:build slbench

package daemon

import (
	"net"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
)

type pbSyncCommand = pb.SyncProxySecureLinksCommand

func sourceCommandFor(linkID string) *pb.SyncProxySecureLinksCommand {
	return &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{{LinkId: linkID, Role: "source", Generation: 1, SocketOnly: true}}}
}

func benchMasterPID(manager *nginx.Manager) func() (int, error) { return manager.CachedPID }

func benchEstablished(connection net.Conn) { secureLinkEstablished(connection) }

func benchShed(links *sourceLinkManager) uint64 { return links.shed.Load() }
