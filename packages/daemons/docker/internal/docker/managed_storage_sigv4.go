package docker

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	sigV4Algorithm      = "AWS4-HMAC-SHA256"
	sigV4TimeFormat     = "20060102T150405Z"
	sigV4DateFormat     = "20060102"
	sigV4EmptyBodyHash  = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	sigV4ContentHashKey = "X-Amz-Content-Sha256"
)

// signSigV4 signs req in place with AWS Signature Version 4 (header form).
// It signs host, content-type (when present) and every x-amz-* header, and
// sets X-Amz-Date itself. bodyHash is the lowercase hex SHA-256 of the body.
func signSigV4(req *http.Request, bodyHash, accessKey, secretKey, region, service string, now time.Time) {
	now = now.UTC()
	amzDate := now.Format(sigV4TimeFormat)
	date := now.Format(sigV4DateFormat)
	req.Header.Set("X-Amz-Date", amzDate)

	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	headers := map[string]string{"host": host}
	for name, values := range req.Header {
		lower := strings.ToLower(name)
		if lower == "content-type" || strings.HasPrefix(lower, "x-amz-") {
			trimmed := make([]string, len(values))
			for index, value := range values {
				trimmed[index] = strings.Join(strings.Fields(value), " ")
			}
			headers[lower] = strings.Join(trimmed, ",")
		}
	}
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	var canonicalHeaders strings.Builder
	for _, name := range names {
		canonicalHeaders.WriteString(name)
		canonicalHeaders.WriteByte(':')
		canonicalHeaders.WriteString(headers[name])
		canonicalHeaders.WriteByte('\n')
	}
	signedHeaders := strings.Join(names, ";")

	canonicalRequest := strings.Join([]string{
		req.Method,
		sigV4CanonicalPath(req.URL),
		sigV4CanonicalQuery(req.URL.Query()),
		canonicalHeaders.String(),
		signedHeaders,
		bodyHash,
	}, "\n")
	requestHash := sha256.Sum256([]byte(canonicalRequest))
	scope := date + "/" + region + "/" + service + "/aws4_request"
	stringToSign := strings.Join([]string{sigV4Algorithm, amzDate, scope, hex.EncodeToString(requestHash[:])}, "\n")

	key := sigV4HMAC([]byte("AWS4"+secretKey), date)
	key = sigV4HMAC(key, region)
	key = sigV4HMAC(key, service)
	key = sigV4HMAC(key, "aws4_request")
	signature := hex.EncodeToString(sigV4HMAC(key, stringToSign))
	req.Header.Set("Authorization", sigV4Algorithm+" Credential="+accessKey+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+signature)
}

func sigV4HMAC(key []byte, value string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(value))
	return mac.Sum(nil)
}

func sigV4Hash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func sigV4CanonicalPath(u *url.URL) string {
	path := u.EscapedPath()
	if path == "" {
		return "/"
	}
	segments := strings.Split(path, "/")
	for index, segment := range segments {
		decoded, err := url.PathUnescape(segment)
		if err != nil {
			decoded = segment
		}
		segments[index] = sigV4Escape(decoded)
	}
	return strings.Join(segments, "/")
}

func sigV4CanonicalQuery(values url.Values) string {
	pairs := make([]string, 0, len(values))
	for name, list := range values {
		for _, value := range list {
			pairs = append(pairs, sigV4Escape(name)+"="+sigV4Escape(value))
		}
	}
	sort.Strings(pairs)
	return strings.Join(pairs, "&")
}

// sigV4Escape percent-encodes everything except RFC 3986 unreserved bytes.
func sigV4Escape(value string) string {
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		c := value[index]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' {
			builder.WriteByte(c)
			continue
		}
		builder.WriteString("%")
		builder.WriteString(strings.ToUpper(hex.EncodeToString([]byte{c})))
	}
	return builder.String()
}
