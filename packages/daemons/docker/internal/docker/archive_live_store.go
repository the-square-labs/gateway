package docker

import (
	"fmt"
	"io"
	"strings"
	"sync"
)

type archiveLiveSession struct {
	reader  io.ReadCloser
	writer  io.WriteCloser
	done    chan archiveImportResult
	cleanup func()
}

type archiveLiveStore struct {
	mu       sync.Mutex
	sessions map[string]*archiveLiveSession
}

func newArchiveLiveStore() *archiveLiveStore {
	return &archiveLiveStore{sessions: make(map[string]*archiveLiveSession)}
}

func archiveLiveKey(archiveID, artifactID string) string { return archiveID + ":" + artifactID }

func (s *archiveLiveStore) put(archiveID, artifactID string, session *archiveLiveSession) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := archiveLiveKey(archiveID, artifactID)
	if _, exists := s.sessions[key]; exists {
		return fmt.Errorf("archive stream is already active")
	}
	s.sessions[key] = session
	return nil
}

func (s *archiveLiveStore) reader(archiveID, artifactID string) (io.ReadCloser, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[archiveLiveKey(archiveID, artifactID)]
	if !ok || session.reader == nil {
		return nil, false
	}
	return session.reader, true
}

func (s *archiveLiveStore) writer(archiveID, artifactID string) (io.WriteCloser, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[archiveLiveKey(archiveID, artifactID)]
	if !ok || session.writer == nil {
		return nil, false
	}
	return session.writer, true
}

func (s *archiveLiveStore) get(archiveID, artifactID string) (*archiveLiveSession, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[archiveLiveKey(archiveID, artifactID)]
	return session, ok
}

func (s *archiveLiveStore) removeSession(archiveID, artifactID string, cleanup bool) {
	s.mu.Lock()
	session := s.sessions[archiveLiveKey(archiveID, artifactID)]
	delete(s.sessions, archiveLiveKey(archiveID, artifactID))
	s.mu.Unlock()
	if session != nil {
		if session.reader != nil {
			_ = session.reader.Close()
		}
		if session.writer != nil {
			_ = session.writer.Close()
		}
		if cleanup && session.cleanup != nil {
			session.cleanup()
		}
	}
}

func (s *archiveLiveStore) remove(archiveID, artifactID string) {
	s.removeSession(archiveID, artifactID, true)
}

func (s *archiveLiveStore) release(archiveID, artifactID string) {
	s.removeSession(archiveID, artifactID, false)
}

func (s *archiveLiveStore) removeArchive(archiveID string) {
	s.mu.Lock()
	var sessions []*archiveLiveSession
	for key, session := range s.sessions {
		if strings.HasPrefix(key, archiveID+":") {
			sessions = append(sessions, session)
			delete(s.sessions, key)
		}
	}
	s.mu.Unlock()
	for _, session := range sessions {
		if session.reader != nil {
			_ = session.reader.Close()
		}
		if session.writer != nil {
			_ = session.writer.Close()
		}
		if session.cleanup != nil {
			session.cleanup()
		}
	}
}
