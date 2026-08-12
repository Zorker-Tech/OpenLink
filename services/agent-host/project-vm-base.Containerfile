# This is an OS image, not a session container.  Podman Machine applies it
# through bootc before a Project VM can host OpenSandbox and browser services.
# Keep the major/minor tag aligned with the bundled Podman machine client.
ARG OPENLINK_MACHINE_OS_IMAGE=quay.io/podman/machine-os:6.2
FROM ${OPENLINK_MACHINE_OS_IMAGE}

# The marker must be present before the ostree commit. bootc ignores ordinary
# OCI layers added after the committed deployment, so copying it afterward
# would make a successfully booted VM look unprovisioned.
COPY project-vm-base.json /usr/lib/openlink/project-vm-base.json
RUN chmod 0644 /usr/lib/openlink/project-vm-base.json

# Project VMs are developer environments. These packages are deliberately in
# the immutable deployment so a new session never mutates its Project VM
# before executing work. `ostree container commit` is required for a bootable
# OCI layer consumed by `bootc switch`.
RUN dnf install -y \
      bash-completion \
      ca-certificates \
      cmake \
      curl \
      diffutils \
      fd-find \
      findutils \
      git \
      gzip \
      jq \
      make \
      nodejs \
      npm \
      openssh-clients \
      pnpm \
      procps-ng \
      python3 \
      python3-devel \
      python3-pip \
      ripgrep \
      tar \
      unzip \
      wget \
      which \
      xz \
      zip \
      gcc \
      gcc-c++ \
    && dnf clean all \
    && ostree container commit
