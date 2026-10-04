package docker

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// The connectors (uid 65532) reach the daemon's socket directories and link sockets by ownership under a root daemon
// and by the daemon's group without root. A switch of the daemon's user changes both while connectors of the previous
// mode still run: the installer gives the files to the new user, and a connector of the previous mode lost access to
// the sockets it uses until the daemon replaced it (connections reset for seconds). An access ACL entry for uid 65532
// on the directories and sockets keeps that access through the switch whoever owns them; it gives the connectors
// nothing they did not have in one of the modes.

const (
	posixACLXattr   = "system.posix_acl_access"
	posixACLVersion = 2
	aclUserObj      = 0x01
	aclUser         = 0x02
	aclGroupObj     = 0x04
	aclMask         = 0x10
	aclOther        = 0x20
	aclUndefinedID  = 0xffffffff
)

// grantConnectorAccess gives uid 65532 the permissions perms (4 read, 2 write, 1 execute) on path with an access
// ACL entry, next to the permissions of its mode. Call it after every chmod: a chmod narrows the ACL mask. A file
// system without ACLs is left as it is.
func grantConnectorAccess(path string, perms uint16) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	mode := uint16(info.Mode().Perm())
	owner, group, other := mode>>6&7, mode>>3&7, mode&7
	entries := []struct {
		tag, perm uint16
		id        uint32
	}{
		{aclUserObj, owner, aclUndefinedID},
		{aclUser, perms, connectorUID},
		{aclGroupObj, group, aclUndefinedID},
		{aclMask, group | perms, aclUndefinedID},
		{aclOther, other, aclUndefinedID},
	}
	value := make([]byte, 4, 4+8*len(entries))
	binary.LittleEndian.PutUint32(value, posixACLVersion)
	for _, entry := range entries {
		value = binary.LittleEndian.AppendUint16(value, entry.tag)
		value = binary.LittleEndian.AppendUint16(value, entry.perm)
		value = binary.LittleEndian.AppendUint32(value, entry.id)
	}
	err = unix.Setxattr(path, posixACLXattr, value, 0)
	if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EOPNOTSUPP) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("give the connectors access to %s: %w", path, err)
	}
	return nil
}

// connectorACLPermissions returns the permissions the access ACL of path gives uid 65532 (false: none set).
func connectorACLPermissions(path string) (uint16, bool) {
	value := make([]byte, 256)
	size, err := unix.Getxattr(path, posixACLXattr, value)
	if err != nil || size < 4 {
		return 0, false
	}
	for offset := 4; offset+8 <= size; offset += 8 {
		tag := binary.LittleEndian.Uint16(value[offset:])
		if tag == aclUser && binary.LittleEndian.Uint32(value[offset+4:]) == connectorUID {
			return binary.LittleEndian.Uint16(value[offset+2:]), true
		}
	}
	return 0, false
}
