FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Alle Module im Hauptverzeichnis (server.js, self-service.js, retention.js, ...)
COPY *.js ./
COPY app/ ./app/
COPY db/00-schema.sql ./db/00-schema.sql

EXPOSE 3000

CMD ["node", "server.js"]
