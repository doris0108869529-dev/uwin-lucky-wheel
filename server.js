const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
const PORT = process.env.PORT || 3000;

const token = process.env.BOT_TOKEN;

const bot = new TelegramBot(token, { polling: true });

const wheelUrl =
  "https://doris0108869529-dev.github.io/uwin-lucky-wheel/";

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(
    chatId,
    "🎡 UWIN LUCKY WHEEL\n\nTekan butang di bawah untuk SPIN 👇",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🎡 SPIN NOW",
              web_app: {
                url: wheelUrl
              }
            }
          ]
        ]
      }
    }
  );
});

app.get("/", (req, res) => {
  res.send("Uwin Lucky Wheel Bot is running!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});