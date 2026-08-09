FROM docker.io/library/golang:1.24@sha256:d2d2bc1c84f7e60d7d2438a3836ae7d0c847f4888464e7ec9ba3a1339a1ee804 AS build
ARG RELAY_BUILD_VERSION=dev
WORKDIR /src
COPY packages/daemons/shared ./packages/daemons/shared
COPY packages/relay ./packages/relay
WORKDIR /src/packages/relay
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.buildVersion=${RELAY_BUILD_VERSION}" -o /gateway-relay ./cmd/gateway-relay

FROM scratch
COPY --from=build /gateway-relay /gateway-relay
ENTRYPOINT ["/gateway-relay"]
