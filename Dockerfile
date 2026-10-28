# docker build -t wheelman .
# docker run --env-file .env -v "$PWD/wallets:/app/wallets:ro" wheelman
FROM node:24-slim
WORKDIR /app
COPY . .
RUN npm ci --omit=dev && chown node /app
USER node
CMD ["node", "src/cli.ts", "run"]
