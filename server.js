const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

// ==============================
// TELEGRAM BOT
// 不使用 polling，避免 409 Conflict
// ==============================

const bot = new TelegramBot(BOT_TOKEN, {
  polling: false
});

// ==============================
// DATABASE
// ==============================

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ==============================
// SETTINGS
// ==============================

const wheelUrl =
  "https://doris0108869529-dev.github.io/uwin-lucky-wheel/";

const renderUrl =
  "https://uwin-lucky-wheel.onrender.com";

const webhookPath =
  "/telegram-webhook";

const webhookUrl =
  renderUrl + webhookPath;

// 可以使用 GIVE 1 SPIN 的客服
const ADMINS = [
  8780423196,
  8551800786,
  934555515,
  8720982986,
  6010203542
];

// ==============================
// EXPRESS
// ==============================

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// ==============================
// DATABASE INIT
// ==============================

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

// ==============================
// CHECK SPIN BALANCE
// ==============================

app.get("/spins/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT spins
      FROM customer_spins
      WHERE telegram_id = $1
      `,
      [req.params.id]
    );

    const spins =
      result.rows.length > 0
        ? result.rows[0].spins
        : 0;

    res.json({
      spins
    });
  } catch (error) {
    console.error(
      "GET SPINS ERROR:",
      error
    );

    res.status(500).json({
      error: "Database error"
    });
  }
});

// ==============================
// USE 1 SPIN
// ==============================

app.post("/spin/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `
      UPDATE customer_spins

      SET spins = spins - 1

      WHERE telegram_id = $1
      AND spins > 0

      RETURNING spins
      `,
      [req.params.id]
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
    console.error(
      "SPIN ERROR:",
      error
    );

    res.status(500).json({
      error: "Database error"
    });
  }
});

// ==============================
// INLINE MODE
// 客服输入：
// @UwinLuckyWheelBot spin
// ==============================

bot.on("inline_query", async (query) => {
  console.log(
    "INLINE QUERY:",
    query.from.id,
    query.query
  );

  try {
    const adminId = query.from.id;

    // 只有指定客服可以使用
    if (!ADMINS.includes(adminId)) {
      await bot.answerInlineQuery(
        query.id,
        [],
        {
          cache_time: 0,
          is_personal: true
        }
      );

      return;
    }

    const grantToken =
      crypto
        .randomBytes(18)
        .toString("hex");

    await pool.query(
      `
      INSERT INTO spin_grants
      (
        token,
        created_by
      )
      VALUES ($1, $2)
      `,
      [
        grantToken,
        adminId
      ]
    );

    const claimUrl =
      "https://t.me/UwinLuckyWheelBot?start=spin_" +
      grantToken;

    const results = [
      {
        type: "article",

        id: grantToken,

        title: "🎡 GIVE 1 SPIN",

        description:
          "Berikan customer 1 peluang Lucky Wheel",

        input_message_content: {
          message_text:
            "🎁 Anda mendapat 1 peluang SPIN!\n\nTekan butang di bawah untuk claim 👇"
        },

        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "🎡 CLAIM 1 SPIN",

                url: claimUrl
              }
            ]
          ]
        }
      }
    ];

    await bot.answerInlineQuery(
      query.id,
      results,
      {
        cache_time: 0,
        is_personal: true
      }
    );

    console.log(
      "INLINE RESULT SENT:",
      adminId
    );
  } catch (error) {
    console.error(
      "INLINE ERROR:",
      error
    );
  }
});

// ==============================
// /START
// 同时处理 CLAIM 1 SPIN
// ==============================

bot.onText(
  /\/start(?:\s+(.+))?/,
  async (msg, match) => {
    const chatId = msg.chat.id;
    const startParam = match[1];

    try {
      // ==========================
      // CLAIM 1 SPIN
      // ==========================

      if (
        startParam &&
        startParam.startsWith("spin_")
      ) {
        const grantToken =
          startParam.substring(5);

        const client =
          await pool.connect();

        try {
          await client.query("BEGIN");

          const claim =
            await client.query(
              `
              UPDATE spin_grants

              SET
                claimed_by = $2,
                claimed_at = NOW()

              WHERE token = $1
              AND claimed_by IS NULL

              RETURNING token
              `,
              [
                grantToken,
                chatId
              ]
            );

          // 已经有人领取过
          if (claim.rows.length === 0) {
            await client.query(
              "ROLLBACK"
            );

            await bot.sendMessage(
              chatId,
              "❌ Peluang SPIN ini telah digunakan."
            );

            return;
          }

          // 顾客 +1 SPIN
          const result =
            await client.query(
              `
              INSERT INTO customer_spins
              (
                telegram_id,
                spins
              )

              VALUES ($1, 1)

              ON CONFLICT
              (telegram_id)

              DO UPDATE SET
              spins =
              customer_spins.spins + 1

              RETURNING spins
              `,
              [chatId]
            );

          await client.query(
            "COMMIT"
          );

          const balance =
            result.rows[0].spins;

          await bot.sendMessage(
            chatId,
            `✅ 1 SPIN berjaya diterima!\n\nBaki SPIN: ${balance}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text:
                        "🎡 SPIN NOW",

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
          await client.query(
            "ROLLBACK"
          );

          throw error;
        } finally {
          client.release();
        }
      }

      // ==========================
      // NORMAL /START
      // ==========================

      const result =
        await pool.query(
          `
          SELECT spins
          FROM customer_spins
          WHERE telegram_id = $1
          `,
          [chatId]
        );

      const balance =
        result.rows.length > 0
          ? result.rows[0].spins
          : 0;

      await bot.sendMessage(
        chatId,
        `🎡 UWIN LUCKY WHEEL\n\nPeluang SPIN anda: ${balance}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    "🎡 SPIN NOW",

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
      console.error(
        "START ERROR:",
        error
      );
    }
  }
);

// ==============================
// /ADD
// 保留旧方式备用
// ==============================

bot.onText(
  /\/add\s+(\d+)/,
  async (msg, match) => {
    const adminId =
      msg.from.id;

    if (!ADMINS.includes(adminId)) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Anda tidak mempunyai akses."
      );

      return;
    }

    try {
      const customerId =
        match[1];

      const result =
        await pool.query(
          `
          INSERT INTO customer_spins
          (
            telegram_id,
            spins
          )

          VALUES ($1, 1)

          ON CONFLICT
          (telegram_id)

          DO UPDATE SET
          spins =
          customer_spins.spins + 1

          RETURNING spins
          `,
          [customerId]
        );

      const balance =
        result.rows[0].spins;

      await bot.sendMessage(
        msg.chat.id,
        `✅ +1 SPIN\nCustomer ID: ${customerId}\nBaki SPIN: ${balance}`
      );
    } catch (error) {
      console.error(
        "ADD SPIN ERROR:",
        error
      );

      await bot.sendMessage(
        msg.chat.id,
        "❌ Error. Sila cuba lagi."
      );
    }
  }
);

// ==============================
// TELEGRAM WEBHOOK
// ==============================

app.post(
  webhookPath,
  (req, res) => {
    try {
      bot.processUpdate(
        req.body
      );

      res.sendStatus(200);
    } catch (error) {
      console.error(
        "WEBHOOK UPDATE ERROR:",
        error
      );

      res.sendStatus(500);
    }
  }
);

// ==============================
// RENDER HEALTH CHECK
// ==============================

app.get("/", (req, res) => {
  res.send(
    "Uwin Lucky Wheel Bot is running!"
  );
});

// ==============================
// START SERVER
// ==============================

app.listen(
  PORT,
  async () => {
    console.log(
      `Server running on port ${PORT}`
    );

    try {
      // 1. Database
      await initDatabase();

      // 2. 直接使用 Telegram 官方 API
      // 设置 webhook + inline_query
      const webhookResponse =
        await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body: JSON.stringify({
              url: webhookUrl,

              allowed_updates: [
                "message",
                "inline_query",
                "callback_query"
              ],

              drop_pending_updates:
                true
            })
          }
        );

      const webhookResult =
        await webhookResponse.json();

      console.log(
        "SET WEBHOOK:",
        webhookResult
      );

      if (!webhookResult.ok) {
        throw new Error(
          webhookResult.description ||
          "Webhook setup failed"
        );
      }

      // 3. 再确认 Telegram 实际保存了什么
      const infoResponse =
        await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`
        );

      const infoResult =
        await infoResponse.json();

      console.log(
        "WEBHOOK URL:",
        infoResult.result?.url
      );

      console.log(
        "ALLOWED UPDATES:",
        infoResult.result
          ?.allowed_updates
      );

      console.log(
        "Webhook ready!"
      );
    } catch (error) {
      console.error(
        "STARTUP ERROR:",
        error
      );
    }
  }
);