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

# Project Supabase is independent from the OpenLink control-plane backend. The
# exact upstream self-hosted configuration and reviewed lock are immutable OS
# inputs; project data and secrets are created only after a Project VM exists.
COPY project-supabase/runtime.lock.json /usr/lib/openlink/project-supabase/runtime.lock.json
COPY project-supabase/runtime.spec.json /usr/lib/openlink/project-supabase/runtime.spec.json
COPY project-supabase/release-trust.json /usr/lib/openlink/project-supabase/release-trust.json
COPY project-supabase/configuration /usr/lib/openlink/project-supabase/configuration
COPY project-vm-seed-supabase.sh /usr/libexec/openlink/project-vm-seed-supabase
COPY project-supabase-runtime.mjs /usr/libexec/openlink/project-supabase-runtime
COPY project-supabase-bundle.mjs /usr/libexec/openlink/project-supabase-bundle.mjs
RUN chmod 0644 /usr/lib/openlink/project-supabase/runtime.lock.json \
    && chmod 0644 /usr/lib/openlink/project-supabase/runtime.spec.json \
    && chmod 0644 /usr/lib/openlink/project-supabase/release-trust.json \
    && find /usr/lib/openlink/project-supabase/configuration -type d -exec chmod 0755 {} + \
    && find /usr/lib/openlink/project-supabase/configuration -type f -exec chmod 0644 {} + \
    && find /usr/lib/openlink/project-supabase/configuration -type f -name '*.sh' -exec chmod 0755 {} + \
    && chmod 0755 /usr/libexec/openlink/project-vm-seed-supabase \
    && chmod 0755 /usr/libexec/openlink/project-supabase-runtime \
    && chmod 0644 /usr/libexec/openlink/project-supabase-bundle.mjs

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
      e2fsprogs \
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
      qemu-img \
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
