# Disposable Build 215 acceptance node: systemd, sshd, password sudo, needrestart.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus openssh-server sudo curl ca-certificates needrestart python3 iproute2 \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash anx && echo 'anx:anx215-disposable-pw' | chpasswd && usermod -aG sudo anx \
 && mkdir -p /home/anx/.ssh && chmod 700 /home/anx/.ssh && chown anx:anx /home/anx/.ssh \
 && systemctl enable ssh
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
