const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");
const crypto = require("crypto");

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
  8720982986,
  6010203542
];

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_spins (
      telegram_id BIGINT PRIMARY KEY,
      spins INTEGER NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS spin_grants (
      token VARCHAR(64) PRIMARY KEY,
      created_by BIGINT NOT NULL,
      claimed_by BIGINT,
      created_at TIMESTAMP DEFAULT NOW(),
      claimed_at TIMESTAMP
    )
  `);

  console.log("Database ready!");
}

initDatabase().catch(console.error);

// 查询剩余 SPIN
app.get("/spins/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT spins FROM customer_spins WHERE telegram_id = $1",
      [req.params.id]
    );

    res.json({
      spins: result.rows.length ? result.rows[0].spins : 0
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Database error" });
  }
});

// 转一次扣 1 SPIN
app.post("/spin/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE customer_spins
       SET spins = spins - 1
       WHERE telegram_id = $1
       AND spins > 0
       RETURNING spins`,
      [req.params.id]
    );

    if (!result.rows.length) {
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

// INLINE MODE：客服在顾客聊天输入 @UwinLuckyWheelBot
bot.on("inline_query", async (query) => {
  try {
    const adminId = query.from.id;

    // 只有4个客服看得到 GIVE 1 SPIN
    if (!ADMINS.includes(adminId)) {
      await bot.answerInlineQuery(query.id, [], {
        cache_time: 0,
        is_personal: true
      });
      return;
    }

    const grantToken = crypto.randomBytes(18).toString("hex");

    await pool.query(
      `INSERT INTO spin_grants (token, created_by)
       VALUES ($1, $2)`,
      [grantToken, adminId]
    );

    const claimUrl =
      `https://t.me/UwinLuckyWheelBot?start=spin_${grantToken}`;

    await bot.answerInlineQuery(
      query.id,
      [
        {
          type: "article",
          id: grantToken,
          title: "🎡 GIVE 1 SPIN",
          description: "Berikan customer 1 peluang Lucky Wheel",
          input_message_content: {
            message_text:
              "🎁 Anda mendapat 1 peluang SPIN!\n\nTekan butang di bawah untuk claim 👇"
          },
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🎡 CLAIM 1 SPIN",
                  url: claimUrl
                }
              ]
            ]
          }
        }
      ],
      {
        cache_time: 0,
        is_personal: true
      }
    );
  } catch (error) {
    console.error("INLINE ERROR:", error);
  }
});

// /start 或领取客服送出的 SPIN
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const startParam = match[1];

  try {
    // 顾客点击 CLAIM 1 SPIN
    if (startParam && startParam.startsWith("spin_")) {
      const grantToken = startParam.substring(5);
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const claim = await client.query(
          `UPDATE spin_grants
           SET claimed_by = $2,
               claimed_at = NOW()
           WHERE token = $1
           AND claimed_by IS NULL
           RETURNING token`,
          [grantToken, chatId]
        );

        if (!claim.rows.length) {
          await client.query("ROLLBACK");

          await bot.sendMessage(
            chatId,
            "❌ Peluang SPIN ini telah digunakan."
          );
          return;
        }

        const result = await client.query(
          `INSERT INTO customer_spins (telegram_id, spins)
           VALUES ($1, 1)
           ON CONFLICT (telegram_id)
           DO UPDATE SET spins = customer_spins.spins + 1
           RETURNING spins`,
          [chatId]
        );

        await client.query("COMMIT");

        const balance = result.rows[0].spins;

        await bot.sendMessage(
          chatId,
          `✅ 1 SPIN berjaya diterima!\n\nBaki SPIN: ${balance}`,
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

        return;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    // 普通 /start
    const result = await pool.query(
      "SELECT spins FROM customer_spins WHERE telegram_id = $1",
      [chatId]
    );

    const balance =
      result.rows.length ? result.rows[0].spins : 0;

    await bot.sendMessage(
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
    console.error("START ERROR:", error);
  }
});

// 保留旧 /add，当备用
bot.onText(/\/add\s+(\d+)/, async (msg, match) => {
  const adminId = msg.from.id;

  if (!ADMINS.includes(adminId)) {
    await bot.sendMessage(
      msg.chat.id,
      "❌ Anda tidak mempunyai akses."
    );
    return;
  }

  try {
    const customerId = match[1];

    const result = await pool.query(
      `INSERT INTO customer_spins (telegram_id, spins)
       VALUES ($1, 1)
       ON CONFLICT (telegram_id)
       DO UPDATE SET spins = customer_spins.spins + 1
       RETURNING spins`,
      [customerId]
    );

    await bot.sendMessage(
      msg.chat.id,
      `✅ +1 SPIN\nCustomer ID: ${customerId}\nBaki SPIN: ${result.rows[0].spins}`
    );
  } catch (error) {
    console.error(error);
  }
});

app.get("/", (req, res) => {
  res.send("Uwin Lucky Wheel Bot is running!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});