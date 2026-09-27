const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const bot = new TelegramBot(BOT_TOKEN, {
  polling: false
});

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const wheelUrl =
  "https://doris0108869529-dev.github.io/uwin-lucky-wheel/";

const renderUrl =
  "https://uwin-lucky-wheel.onrender.com";

const webhookPath = "/telegram-webhook";
const webhookUrl = renderUrl + webhookPath;

const ADMINS = [
  8780423196,
  8551800786,
  934555515,
  8720982986,
  6010203542
];

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

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

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
      claimed_at TIMESTAMP,
      inline_message_id TEXT,
      result_sent BOOLEAN NOT NULL DEFAULT FALSE
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
// CHECK CUSTOMER BALANCE
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

    res.json({ spins });
  } catch (error) {
    console.error("GET SPINS ERROR:", error);
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
    console.error("SPIN ERROR:", error);
    res.status(500).json({
      error: "Database error"
    });
  }
});

// ==============================
// RECEIVE RESULT FROM WHEEL
// 转完后：
// 1) 发给顾客和 Bot 的私聊
// 2) 改掉原本客服和顾客聊天里的那张卡片
// ==============================

app.post("/result/:id", async (req, res) => {
  try {
    const customerId = req.params.id;
    const prize = req.body?.prize;

    if (!prize || !VALID_PRIZES.includes(prize)) {
      return res.status(400).json({
        success: false,
        error: "Invalid prize"
      });
    }

    await pool.query(
      `
      INSERT INTO spin_results
      (
        telegram_id,
        prize
      )
      VALUES ($1, $2)
      `,
      [customerId, prize]
    );

    // 找出这个顾客最近一个“已领取但还没发结果”的 grant
    const grantResult = await pool.query(
      `
      SELECT
        token,
        inline_message_id
      FROM spin_grants
      WHERE claimed_by = $1
      AND result_sent = FALSE
      ORDER BY claimed_at ASC
      LIMIT 1
      `,
      [customerId]
    );

    if (grantResult.rows.length > 0) {
      const grant = grantResult.rows[0];

      // 修改原本客服和顾客聊天中的 inline 卡片
      if (grant.inline_message_id) {
        try {
          await bot.editMessageText(
            `🎉 KEPUTUSAN LUCKY WHEEL\n\n🎁 Hadiah anda: ${prize}\n\n✅ Sila tunggu admin masukkan hadiah anda.`,
            {
              inline_message_id: grant.inline_message_id
            }
          );

          console.log(
            "ORIGINAL CHAT UPDATED:",
            customerId,
            prize
          );
        } catch (editError) {
          console.error(
            "EDIT INLINE ERROR:",
            editError
          );
        }
      }

      await pool.query(
        `
        UPDATE spin_grants
        SET result_sent = TRUE
        WHERE token = $1
        `,
        [grant.token]
      );
    }

    // 同时发回顾客和 Bot 的私聊
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
      prize
    });
  } catch (error) {
    console.error("RESULT ERROR:", error);
    res.status(500).json({
      success: false,
      error: "Result error"
    });
  }
});

// ==============================
// INLINE QUERY
// 客服在顾客聊天输入：
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
      crypto.randomBytes(18).toString("hex");

    await pool.query(
      `
      INSERT INTO spin_grants
      (
        token,
        created_by
      )
      VALUES ($1, $2)
      `,
      [grantToken, adminId]
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
                text: "🎡 CLAIM 1 SPIN",
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
  } catch (error) {
    console.error("INLINE ERROR:", error);
  }
});

// ==============================
// INLINE FEEDBACK
// 记录真正被发送出去的那张卡片 ID
// ==============================

bot.on("chosen_inline_result", async (chosen) => {
  try {
    console.log(
      "CHOSEN INLINE:",
      chosen.result_id,
      chosen.inline_message_id
    );

    if (
      chosen.result_id &&
      chosen.inline_message_id
    ) {
      await pool.query(
        `
        UPDATE spin_grants
        SET inline_message_id = $2
        WHERE token = $1
        `,
        [
          chosen.result_id,
          chosen.inline_message_id
        ]
      );

      console.log("INLINE MESSAGE SAVED");
    }
  } catch (error) {
    console.error(
      "CHOSEN INLINE ERROR:",
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
    const chatId = msg.chat.id;
    const startParam = match[1];

    try {
      // 顾客点击 CLAIM 1 SPIN
      if (
        startParam &&
        startParam.startsWith("spin_")
      ) {
        const grantToken =
          startParam.substring(5);

        const client = await pool.connect();

        try {
          await client.query("BEGIN");

          const claim = await client.query(
            `
            UPDATE spin_grants
            SET
              claimed_by = $2,
              claimed_at = NOW()
            WHERE token = $1
            AND claimed_by IS NULL
            RETURNING token
            `,
            [grantToken, chatId]
          );

          if (claim.rows.length === 0) {
            await client.query("ROLLBACK");

            await bot.sendMessage(
              chatId,
              "❌ Peluang SPIN ini telah digunakan."
            );

            return;
          }

          const result = await client.query(
            `
            INSERT INTO customer_spins
            (
              telegram_id,
              spins
            )
            VALUES ($1, 1)
            ON CONFLICT (telegram_id)
            DO UPDATE SET
            spins = customer_spins.spins + 1
            RETURNING spins
            `,
            [chatId]
          );

          await client.query("COMMIT");

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
  }
);

// ==============================
// /ADD 备用
// ==============================

bot.onText(
  /\/add\s+(\d+)/,
  async (msg, match) => {
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
        `
        INSERT INTO customer_spins
        (
          telegram_id,
          spins
        )
        VALUES ($1, 1)
        ON CONFLICT (telegram_id)
        DO UPDATE SET
        spins = customer_spins.spins + 1
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
    }
  }
);

// ==============================
// WEBHOOK
// ==============================

app.post(webhookPath, (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error("WEBHOOK ERROR:", error);
    res.sendStatus(500);
  }
});

// ==============================
// DEBUG
// ==============================

app.get("/debug-bot", async (req, res) => {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getMe`
    );

    const data = await response.json();

    res.json({
      ok: data.ok,
      username: data.result?.username,
      supports_inline_queries:
        data.result?.supports_inline_queries
    });
  } catch (error) {
    res.status(500).json({
      error: String(error)
    });
  }
});

// ==============================
// HEALTH CHECK
// ==============================

app.get("/", (req, res) => {
  res.send(
    "Uwin Lucky Wheel Bot is running!"
  );
});

// ==============================
// START SERVER
// ==============================

app.listen(PORT, async () => {
  console.log(
    `Server running on port ${PORT}`
  );

  try {
    await initDatabase();

    const webhookResponse = await fetch(
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
            "chosen_inline_result",
            "callback_query"
          ],
          drop_pending_updates: true
        })
      }
    );

    const webhookResult =
      await webhookResponse.json();

    console.log(
      "SET WEBHOOK:",
      webhookResult
    );

    const infoResponse = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`
    );

    const infoResult =
      await infoResponse.json();

    console.log(
      "ALLOWED UPDATES:",
      infoResult.result?.allowed_updates
    );

    console.log("Webhook ready!");
  } catch (error) {
    console.error(
      "STARTUP ERROR:",
      error
    );
  }
});