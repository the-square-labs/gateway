package stream

import (
	"strings"
	"unicode/utf8"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// InvalidUTF8Replacement replaces every invalid UTF-8 sequence in outgoing
// protobuf strings.
const InvalidUTF8Replacement = "�"

// ValidUTF8 returns s with every invalid UTF-8 sequence replaced by U+FFFD.
func ValidUTF8(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	return strings.ToValidUTF8(s, InvalidUTF8Replacement)
}

// SanitizeUTF8 rewrites, in place, every string field of msg that is not valid
// UTF-8: scalar, repeated, map keys and values, and nested messages.
//
// proto3 refuses to marshal a string field holding invalid UTF-8, and gRPC then
// finishes the whole client stream. A single command result carrying raw
// process output (for example a Docker multiplexed stream header) would
// otherwise end the daemon session and fail every in-flight command on the
// node. Fields that are already valid are left untouched, so messages without
// invalid text are never written to.
func SanitizeUTF8(msg proto.Message) {
	if msg == nil {
		return
	}
	sanitizeMessage(msg.ProtoReflect())
}

func sanitizeMessage(m protoreflect.Message) {
	if !m.IsValid() {
		return
	}
	m.Range(func(fd protoreflect.FieldDescriptor, value protoreflect.Value) bool {
		switch {
		case fd.IsMap():
			sanitizeMap(fd, value.Map())
		case fd.IsList():
			sanitizeList(fd, value.List())
		case fd.Kind() == protoreflect.StringKind:
			if s := value.String(); !utf8.ValidString(s) {
				m.Set(fd, protoreflect.ValueOfString(ValidUTF8(s)))
			}
		case isMessageKind(fd.Kind()):
			sanitizeMessage(value.Message())
		}
		return true
	})
}

func sanitizeList(fd protoreflect.FieldDescriptor, list protoreflect.List) {
	for i := 0; i < list.Len(); i++ {
		switch {
		case fd.Kind() == protoreflect.StringKind:
			if s := list.Get(i).String(); !utf8.ValidString(s) {
				list.Set(i, protoreflect.ValueOfString(ValidUTF8(s)))
			}
		case isMessageKind(fd.Kind()):
			sanitizeMessage(list.Get(i).Message())
		}
	}
}

func sanitizeMap(fd protoreflect.FieldDescriptor, entries protoreflect.Map) {
	keyIsString := fd.MapKey().Kind() == protoreflect.StringKind
	valueKind := fd.MapValue().Kind()
	var invalidKeys []protoreflect.MapKey
	entries.Range(func(key protoreflect.MapKey, value protoreflect.Value) bool {
		switch {
		case valueKind == protoreflect.StringKind:
			if s := value.String(); !utf8.ValidString(s) {
				entries.Set(key, protoreflect.ValueOfString(ValidUTF8(s)))
			}
		case isMessageKind(valueKind):
			sanitizeMessage(value.Message())
		}
		if keyIsString && !utf8.ValidString(key.String()) {
			invalidKeys = append(invalidKeys, key)
		}
		return true
	})
	// Keys can only be rewritten outside Range: move each entry to its
	// sanitized key.
	for _, key := range invalidKeys {
		value := entries.Get(key)
		entries.Clear(key)
		entries.Set(protoreflect.ValueOfString(ValidUTF8(key.String())).MapKey(), value)
	}
}

func isMessageKind(kind protoreflect.Kind) bool {
	return kind == protoreflect.MessageKind || kind == protoreflect.GroupKind
}
