FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=4444 \
    MAFIA_DATA_DIR=/app/data

WORKDIR /app

COPY --chown=node:node server.js storage.js mafia-rules.js bot-dialogue.js smtp.js package.json ./
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 4444

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4444) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
