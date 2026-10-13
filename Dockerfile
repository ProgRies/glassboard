FROM node:24-alpine
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Glassboard" \
      org.opencontainers.image.description="A shared whiteboard with no accounts" \
      org.opencontainers.image.source="https://github.com/ProgRies/glassboard" \
      org.opencontainers.image.url="https://github.com/ProgRies/glassboard" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION
WORKDIR /app
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node public ./public
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
