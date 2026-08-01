# Gateway database connector

This first-party sidecar exposes a database TCP port only inside one private
Docker binding network. It forwards raw bytes through the Docker daemon's
Unix socket after a fixed binding-ID handshake. The container never receives
Gateway credentials or any database destination address.

The release pipeline must publish this image under a digest before it is added
to the managed binding catalog.
