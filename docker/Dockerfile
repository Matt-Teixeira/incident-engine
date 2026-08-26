FROM node:lts

# Build-time arguments — no defaults on purpose: a missing value fails the
# build instead of baking a wrong uid into the image.
ARG USER_ID
ARG DOCKER_GID
ARG UID_0
ARG UID_1
ARG UID_2

# Identity label: records who built this image (matches the image tag), not a
# version. RELEASE_SHA in the deployed .env is the runtime provenance record.
LABEL version="${USER_ID}"

SHELL ["/bin/bash", "-c"]

# Tooling: gosu for the entrypoint's user drop; ca-certificates for TLS.
# (No lftp/ssh tooling — incident-engine only talks to PostgreSQL on pg_net.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      gosu \
 && rm -rf /var/lib/apt/lists/*

# Create docker group
RUN groupadd -g ${DOCKER_GID} docker

# Create users
RUN useradd -u ${UID_0} -g docker -m -d /home/svc -s /bin/bash svc
RUN useradd -u ${UID_1} -g docker -m -d /home/jonathan-pope -s /bin/bash jonathan-pope
RUN useradd -u ${UID_2} -g docker -m -d /home/matt-teixeira -s /bin/bash matt-teixeira

# ----------------------------------------------------------
# TO ADD ANOTHER USER:
# 1) Add ARG UID_X at the top
# 2) Add: RUN useradd -u ${UID_X} -g docker -m -d /home/newuser -s /bin/bash newuser
# 3) Add UID_X to docker-compose.yaml build args + .env(.example)
# ----------------------------------------------------------

# Cooperative umask for all shells
RUN printf 'umask ${UMASK:-0002}\n' > /etc/profile.d/umask.sh \
  && chmod 644 /etc/profile.d/umask.sh \
  && printf '\n# cooperative umask for all users\numask ${UMASK:-0002}\n' >> /etc/bash.bashrc

ENV BASH_ENV=/etc/profile.d/umask.sh

# Baked-in entrypoint. Source code, .env, and logs arrive via bind mounts at
# runtime; this is the only file COPYed from the repo (see .dockerignore).
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
