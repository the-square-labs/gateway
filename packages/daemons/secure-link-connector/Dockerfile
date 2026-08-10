FROM docker.io/library/golang:1.24@sha256:d2d2bc1c84f7e60d7d2438a3836ae7d0c847f4888464e7ec9ba3a1339a1ee804 AS build
WORKDIR /src
COPY shared /src/shared
COPY secure-link-connector /src/secure-link-connector
WORKDIR /src/secure-link-connector
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /secure-link-connector ./cmd/secure-link-connector

FROM scratch
COPY --from=build /secure-link-connector /secure-link-connector
USER 65532:65532
ENTRYPOINT ["/secure-link-connector"]
