# Business Wife hub. Zero runtime dependencies; needs Node >= 22 (see
# package.json "engines"). The build fails fast on an older base image.
FROM node:24-alpine
RUN node -e "const m=+process.versions.node.split('.')[0]; if (m < 22) { console.error('Node >= 22 required, got ' + process.versions.node); process.exit(1); }"
WORKDIR /app
COPY . .
ENV PORT=6969
EXPOSE 6969
CMD ["node", "server.js"]
