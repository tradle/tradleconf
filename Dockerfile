FROM node:10

#RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node

# WORKDIR /home/node/app

WORKDIR /app

COPY package*.json ./

# USER node

RUN npm install --production

COPY . .

RUN mkdir -p /app/conf

WORKDIR /app/conf

ENTRYPOINT ["node", "../lib/cmd.js"]
