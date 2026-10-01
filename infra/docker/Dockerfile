# Draft. Ursa needs sharp (libvips binaries ship with the npm package on
# linux-x64/arm64 glibc, so a slim Debian base works; Alpine would need musl builds).
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src
ENV NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8080 7071
CMD ["node", "bin/ursa-server.js", "start", "/config/ursa-server.yml"]
