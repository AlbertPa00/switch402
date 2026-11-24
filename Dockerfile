FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY packages ./packages

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=4020
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data

EXPOSE 4020
CMD ["node", "packages/server/index.mjs"]
