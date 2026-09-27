const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const wheelUrl =
  "https://doris0108869529-dev.github.io/uwin-lucky-wheel/";

const ADMINS = [
  8780423196,
  8551800786,
  934555515,
  8720982986
];

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// 建立永久保存 SPIN 次数的资料表
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_spins (
      telegram_id BIGINT PRIMARY KEY,
      spins INTEGER NOT NULL DEFAULT 0
    )
  `);

  console.log("Database ready!");
}

initDatabase().catch(console.error);

// 查询顾客剩余次数
app.get("/spins/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const result = await pool.query(
      "SELECT spins FROM customer_spins WHERE telegram_id = $1",
      [id]
    );

    const spins =
      result.rows.length > 0 ? result.rows[0].spins : 0;

    res.json({ spins });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Database error" });
  }
});

// 顾客转一次，自动扣 1 次
app.post("/spin/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const result = await pool.query(
      `UPDATE customer_spins
       SET spins = spins - 1
       WHERE telegram_id = $1
       AND spins > 0
       RETURNING spins`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({
        success: false,
        spins: 0
      });
    }

    res.json({
      success: true,
      spins: result.rows[0].spins
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Database error" });
  }
});

// 顾客 /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const result = await pool.query(
      "SELECT spins FROM customer_spins WHERE telegram_id = $1",
      [chatId]
    );

    const balance =
      result.rows.length > 0 ? result.rows[0].spins : 0;

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
  } catch (error) {
    console.error(error);
  }
});

// 只有4个客服可以给顾客 +1 SPIN
bot.onText(/\/add\s+(\d+)/, async (msg, match) => {
  const adminId = msg.from.id;

  if (!ADMINS.includes(adminId)) {
    bot.sendMessage(
      msg.chat.id,
      "❌ Anda tidak mempunyai akses."
    );
    return;
  }

  const customerId = match[1];

  try {
    const result = await pool.query(
      `INSERT INTO customer_spins (telegram_id, spins)
       VALUES ($1, 1)
       ON CONFLICT (telegram_id)
       DO UPDATE SET spins = customer_spins.spins + 1
       RETURNING spins`,
      [customerId]
    );

    const balance = result.rows[0].spins;

    await bot.sendMessage(
      msg.chat.id,
      `✅ +1 SPIN\nCustomer ID: ${customerId}\nBaki SPIN: ${balance}`
    );

    bot.sendMessage(
      customerId,
      `🎉 Topup anda telah disahkan!\n\nAnda mendapat 1 peluang SPIN 🎡\nBaki SPIN: ${balance}`,
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

  } catch (error) {
    console.error(error);
    bot.sendMessage(
      msg.chat.id,
      "❌ Error. Sila cuba lagi."
    );
  }
});

app.get("/", (req, res) => {
  res.send("Uwin Lucky Wheel Bot is running!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});