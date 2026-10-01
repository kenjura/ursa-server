# ursa-server. Ursa needs sharp, whose prebuilt binaries target glibc, so this
# uses a Debian base rather than Alpine. rsync and ssh are for the rsync sink.
FROM node:24-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends rsync openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY bin ./bin
COPY src ./src
ENV NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8080 7071
CMD ["node", "bin/ursa-server.js", "start", "/config/ursa-server.yml"]
