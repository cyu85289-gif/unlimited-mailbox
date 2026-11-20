FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

COPY package.json ./
COPY server.mjs smtp.mjs mime.mjs worker.mjs build-worker.mjs ./
COPY public ./public
COPY config.json ./

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8787 2525
CMD ["node", "--no-warnings", "server.mjs"]
