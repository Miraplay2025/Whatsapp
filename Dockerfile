FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p sessions zips

EXPOSE 10000

CMD ["npm", "start"]
