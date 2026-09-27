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

// 客服 Telegram ID
const ADMINS = [
  8780423196,
  8551800786,
  934555515,
  8720982986,
  6010203542
];

// 合法奖项
const VALID_PRIZES = [
  "10%",
  "20%",
  "30%",
  "40%",
  "RM3",
  "RM5",
  "RM7",
  "RM9"
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS spin_results (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      prize VARCHAR(20) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
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
// RECEIVE WIN RESULT
// 顾客转完后，网页会调用这里
// ==============================

app.post("/result/:id", async (req, res) => {
  try {

    const customerId =
      req.params.id;

    const prize =
      req.body?.prize;

    // 防止乱传不存在的奖项
    if (
      !prize ||
      !VALID_PRIZES.includes(prize)
    ) {

      return res.status(400).json({
        success: false,
        error: "Invalid prize"
      });

    }

    // 保存中奖记录
    await pool.query(
      `
      INSERT INTO spin_results
      (
        telegram_id,
        prize
      )

      VALUES ($1, $2)
      `,
      [
        customerId,
        prize
      ]
    );

    // 发中奖结果给顾客
    await bot.sendMessage(
      customerId,
      `🎉 KEPUTUSAN LUCKY WHEEL\n\n🎁 Hadiah anda: ${prize}\n\nSila tunggu admin masukkan hadiah anda.`
    );

    console.log(
      "RESULT SENT:",
      customerId,
      prize
    );

    res.json({
      success: true,
      prize: prize
    });

  } catch (error) {

    console.error(
      "RESULT ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      error: "Result error"
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

    const adminId =
      query.from.id;

    if (
      !ADMINS.includes(adminId)
    ) {

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

        title:
          "🎡 GIVE 1 SPIN",

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
// /START + CLAIM
// ==============================

bot.onText(
  /\/start(?:\s+(.+))?/,
  async (msg, match) => {

    const chatId =
      msg.chat.id;

    const startParam =
      match[1];

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

          await client.query(
            "BEGIN"
          );

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

          if (
            claim.rows.length === 0
          ) {

            await client.query(
              "ROLLBACK"
            );

            await bot.sendMessage(
              chatId,
              "❌ Peluang SPIN ini telah digunakan."
            );

            return;
          }

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
// /ADD BACKUP
// ==============================

bot.onText(
  /\/add\s+(\d+)/,
  async (msg, match) => {

    const adminId =
      msg.from.id;

    if (
      !ADMINS.includes(adminId)
    ) {

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
// DEBUG BOT
// ==============================

app.get(
  "/debug-bot",
  async (req, res) => {

    try {

      const response =
        await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/getMe`
        );

      const data =
        await response.json();

      res.json({
        ok:
          data.ok,

        username:
          data.result?.username,

        supports_inline_queries:
          data.result
            ?.supports_inline_queries
      });

    } catch (error) {

      res
        .status(500)
        .json({
          error:
            String(error)
        });
    }
  }
);

// ==============================
// HEALTH CHECK
// ==============================

app.get(
  "/",
  (req, res) => {

    res.send(
      "Uwin Lucky Wheel Bot is running!"
    );
  }
);

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

      await initDatabase();

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
              url:
                webhookUrl,

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

      if (
        !webhookResult.ok
      ) {

        throw new Error(
          webhookResult.description ||
          "Webhook setup failed"
        );
      }

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