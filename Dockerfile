FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY app/ ./app/
COPY db/00-schema.sql ./db/00-schema.sql

EXPOSE 3000

CMD ["node", "server.js"]
