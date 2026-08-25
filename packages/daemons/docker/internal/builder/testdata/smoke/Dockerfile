FROM busybox:1.36
RUN printf 'gateway-builder-smoke\n' > /result.txt
RUN test ! -S /var/run/docker.sock
RUN ! wget -T 2 -q -O- http://169.254.169.254/latest/meta-data/
RUN ! wget -T 2 -q -O- https://example.com/
