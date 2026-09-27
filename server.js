const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
const PORT = process.env.PORT || 3000;

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const wheelUrl =
  "https://doris0108869529-dev.github.io/uwin-lucky-wheel/";

// 4 个客服 Telegram ID
const ADMINS = [
  8780423196,
  8591800786,
  934555515,
  8720982986
];

// 暂时记录每位顾客的 SPIN 次数
const spins = {};

// 顾客 /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const balance = spins[chatId] || 0;

  bot.sendMessage(
    chatId,
    `🎡 UWIN LUCKY WHEEL\n\nPeluang SPIN anda: ${balance}`,
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

// 客服给顾客 +1 次
// 用法：/add 顾客TelegramID
bot.onText(/\/add\s+(\d+)/, (msg, match) => {
  const adminId = msg.from.id;

  if (!ADMINS.includes(adminId)) {
    bot.sendMessage(msg.chat.id, "❌ Anda tidak mempunyai akses.");
    return;
  }

  const customerId = match[1];

  spins[customerId] = (spins[customerId] || 0) + 1;

  bot.sendMessage(
    msg.chat.id,
    `✅ +1 SPIN\nCustomer ID: ${customerId}\nBaki SPIN: ${spins[customerId]}`
  );

  bot.sendMessage(
    customerId,
    `🎉 Topup anda telah disahkan!\n\nAnda mendapat 1 peluang SPIN 🎡\nBaki SPIN: ${spins[customerId]}`,
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
  ).catch(() => {});
});

app.get("/", (req, res) => {
  res.send("Uwin Lucky Wheel Bot is running!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});