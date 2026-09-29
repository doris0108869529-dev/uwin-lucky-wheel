const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const bot = new TelegramBot(BOT_TOKEN, {
  polling: false
});

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const WHEEL_URL =
  "https://uwin-service-dev.github.io/uwin-lucky-wheel/";

const RENDER_URL =
  "https://uwin-lucky-wheel.onrender.com";

const WEBHOOK_PATH =
  "/telegram-webhook";

const WEBHOOK_URL =
  RENDER_URL + WEBHOOK_PATH;

// 可以 GIVE 1 SPIN 的客服
const ADMINS = [
  8780423196,
  8551800786,
  934555515,
  8720982986,
  6010203542
];

// ==============================
// 奖项概率（服务器决定）
// ==============================

const PRIZES = [
  { name: "10%", weight: 6 },
  { name: "20%", weight: 30 },
  { name: "30%", weight: 22 },
  { name: "40%", weight: 2 },
  { name: "RM3", weight: 5 },
  { name: "RM5", weight: 8 },
  { name: "RM7", weight: 11 },
  { name: "RM9", weight: 16 }
];

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
// DATABASE
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
      claimed_at TIMESTAMP,
      inline_message_id TEXT,
      prize VARCHAR(20),
      spun_at TIMESTAMP,
      finished_at TIMESTAMP,
      result_sent BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);

  await pool.query(`
    ALTER TABLE spin_grants
    ADD COLUMN IF NOT EXISTS inline_message_id TEXT
  `);

  await pool.query(`
    ALTER TABLE spin_grants
    ADD COLUMN IF NOT EXISTS prize VARCHAR(20)
  `);

  await pool.query(`
    ALTER TABLE spin_grants
    ADD COLUMN IF NOT EXISTS spun_at TIMESTAMP
  `);

  await pool.query(`
    ALTER TABLE spin_grants
    ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP
  `);

  await pool.query(`
    ALTER TABLE spin_grants
    ADD COLUMN IF NOT EXISTS result_sent BOOLEAN
    NOT NULL DEFAULT FALSE
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
// VERIFY TELEGRAM MINI APP USER
// ==============================

function verifyTelegramInitData(initData) {
  try {
    if (!initData) {
      return null;
    }

    const params =
      new URLSearchParams(initData);

    const hash =
      params.get("hash");

    if (
      !hash ||
      !/^[a-f0-9]{64}$/i.test(hash)
    ) {
      return null;
    }

    params.delete("hash");

    const dataCheckString =
      Array.from(params.entries())
        .sort(
          ([a], [b]) =>
            a.localeCompare(b)
        )
        .map(
          ([key, value]) =>
            `${key}=${value}`
        )
        .join("\n");

    const secretKey =
      crypto
        .createHmac(
          "sha256",
          "WebAppData"
        )
        .update(BOT_TOKEN)
        .digest();

    const calculatedHash =
      crypto
        .createHmac(
          "sha256",
          secretKey
        )
        .update(dataCheckString)
        .digest("hex");

    const supplied =
      Buffer.from(hash, "hex");

    const calculated =
      Buffer.from(
        calculatedHash,
        "hex"
      );

    if (
      supplied.length !== calculated.length ||
      !crypto.timingSafeEqual(
        supplied,
        calculated
      )
    ) {
      return null;
    }

    const authDate =
      Number(
        params.get("auth_date")
      );

    if (
      !authDate ||
      Date.now() / 1000 -
        authDate >
        21600
    ) {
      return null;
    }

    const userText =
      params.get("user");

    if (!userText) {
      return null;
    }

    return JSON.parse(userText);

  } catch (error) {
    console.error(
      "VERIFY INIT DATA ERROR:",
      error
    );

    return null;
  }
}

// ==============================
// SERVER-SIDE RANDOM PRIZE
// ==============================

function choosePrize() {
  const random =
    crypto.randomInt(
      0,
      1000000
    );

  let cumulative = 0;

  for (const prize of PRIZES) {
    cumulative +=
      prize.weight * 10000;

    if (random < cumulative) {
      return prize.name;
    }
  }

  return "20%";
}

async function getBalance(
  telegramId,
  db = pool
) {
  const result =
    await db.query(
      `
      SELECT spins
      FROM customer_spins
      WHERE telegram_id = $1
      `,
      [telegramId]
    );

  return result.rows.length
    ? result.rows[0].spins
    : 0;
}

// ==============================
// 把结果写回原本客服 ↔ 顾客聊天
// ==============================

async function syncOriginalChat(
  grantToken
) {
  const result =
    await pool.query(
      `
      SELECT
        token,
        inline_message_id,
        prize,
        result_sent
      FROM spin_grants
      WHERE token = $1
      `,
      [grantToken]
    );

  if (!result.rows.length) {
    return false;
  }

  const grant =
    result.rows[0];

  if (grant.result_sent) {
    return true;
  }

  if (
    !grant.inline_message_id ||
    !grant.prize
  ) {
    return false;
  }

  try {
    await bot.editMessageText(
      `🎉 KEPUTUSAN LUCKY WHEEL\n\n🎁 Hadiah anda: ${grant.prize}\n\n✅ Sila tunggu admin masukkan hadiah anda.`,
      {
        inline_message_id:
          grant.inline_message_id,

        reply_markup: {
          inline_keyboard: []
        }
      }
    );

    await pool.query(
      `
      UPDATE spin_grants
      SET result_sent = TRUE
      WHERE token = $1
      AND result_sent = FALSE
      `,
      [grantToken]
    );

    console.log(
      "ORIGINAL CHAT UPDATED:",
      grantToken,
      grant.prize
    );

    return true;

  } catch (error) {
    console.error(
      "EDIT INLINE ERROR:",
      error
    );

    return false;
  }
}

// ==============================
// MINI APP STATUS
// ==============================

app.post(
  "/spin/status",
  async (req, res) => {
    try {
      const {
        grantToken,
        initData
      } = req.body || {};

      const user =
        verifyTelegramInitData(
          initData
        );

      if (!user) {
        return res
          .status(401)
          .json({
            success: false,
            error:
              "Invalid Telegram session"
          });
      }

      const grantResult =
        await pool.query(
          `
          SELECT
            claimed_by,
            prize
          FROM spin_grants
          WHERE token = $1
          `,
          [grantToken]
        );

      if (
        !grantResult.rows.length
      ) {
        return res
          .status(404)
          .json({
            success: false,
            error:
              "SPIN not found"
          });
      }

      const grant =
        grantResult.rows[0];

      if (
        String(grant.claimed_by) !==
        String(user.id)
      ) {
        return res
          .status(403)
          .json({
            success: false,
            error:
              "This SPIN does not belong to you"
          });
      }

      const balance =
        await getBalance(user.id);

      res.json({
        success: true,
        balance,
        used:
          Boolean(grant.prize),
        prize:
          grant.prize || null
      });

    } catch (error) {
      console.error(
        "STATUS ERROR:",
        error
      );

      res
        .status(500)
        .json({
          success: false
        });
    }
  }
);

// ==============================
// PREPARE SPIN
// ==============================

app.post(
  "/spin/prepare",
  async (req, res) => {
    const {
      grantToken,
      initData
    } = req.body || {};

    const user =
      verifyTelegramInitData(
        initData
      );

    if (!user) {
      return res
        .status(401)
        .json({
          success: false,
          error:
            "Invalid Telegram session"
        });
    }

    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      const grantResult =
        await client.query(
          `
          SELECT
            token,
            claimed_by,
            prize
          FROM spin_grants
          WHERE token = $1
          FOR UPDATE
          `,
          [grantToken]
        );

      if (!grantResult.rows.length) {
        await client.query("ROLLBACK");

        return res
          .status(404)
          .json({
            success: false,
            error:
              "SPIN not found"
          });
      }

      const grant =
        grantResult.rows[0];

      if (
        String(grant.claimed_by) !==
        String(user.id)
      ) {
        await client.query("ROLLBACK");

        return res
          .status(403)
          .json({
            success: false,
            error:
              "This SPIN does not belong to you"
          });
      }

      if (grant.prize) {
        const balance =
          await getBalance(
            user.id,
            client
          );

        await client.query("COMMIT");

        return res.json({
          success: true,
          prize:
            grant.prize,
          balance,
          resumed: true
        });
      }

      const deduct =
        await client.query(
          `
          UPDATE customer_spins
          SET spins = spins - 1
          WHERE telegram_id = $1
          AND spins > 0
          RETURNING spins
          `,
          [user.id]
        );

      if (!deduct.rows.length) {
        await client.query("ROLLBACK");

        return res
          .status(403)
          .json({
            success: false,
            error:
              "No SPIN available"
          });
      }

      const prize =
        choosePrize();

      await client.query(
        `
        UPDATE spin_grants
        SET
          prize = $2,
          spun_at = NOW()
        WHERE token = $1
        `,
        [
          grantToken,
          prize
        ]
      );

      await client.query(
        `
        INSERT INTO spin_results
        (
          telegram_id,
          prize
        )
        VALUES ($1, $2)
        `,
        [
          user.id,
          prize
        ]
      );

      await client.query("COMMIT");

      setTimeout(() => {
        syncOriginalChat(
          grantToken
        ).catch(
          console.error
        );
      }, 6000);

      res.json({
        success: true,
        prize,
        balance:
          deduct.rows[0].spins
      });

    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "PREPARE SPIN ERROR:",
        error
      );

      res
        .status(500)
        .json({
          success: false,
          error:
            "Spin error"
        });

    } finally {
      client.release();
    }
  }
);

// ==============================
// FINISH SPIN
// ==============================

app.post(
  "/spin/finish",
  async (req, res) => {
    try {
      const {
        grantToken,
        initData
      } = req.body || {};

      const user =
        verifyTelegramInitData(
          initData
        );

      if (!user) {
        return res
          .status(401)
          .json({
            success: false
          });
      }

      const grantResult =
        await pool.query(
          `
          SELECT
            claimed_by,
            prize
          FROM spin_grants
          WHERE token = $1
          `,
          [grantToken]
        );

      if (!grantResult.rows.length) {
        return res
          .status(404)
          .json({
            success: false
          });
      }

      const grant =
        grantResult.rows[0];

      if (
        String(grant.claimed_by) !==
        String(user.id)
      ) {
        return res
          .status(403)
          .json({
            success: false
          });
      }

      if (!grant.prize) {
        return res
          .status(400)
          .json({
            success: false
          });
      }

      await pool.query(
        `
        UPDATE spin_grants
        SET finished_at = NOW()
        WHERE token = $1
        `,
        [grantToken]
      );

      const updated =
        await syncOriginalChat(
          grantToken
        );

      res.json({
        success: true,
        updatedOriginalChat:
          updated
      });

    } catch (error) {
      console.error(
        "FINISH ERROR:",
        error
      );

      res
        .status(500)
        .json({
          success: false
        });
    }
  }
);

// ==============================
// INLINE QUERY
// ==============================

bot.on(
  "inline_query",
  async (query) => {
    try {
      const adminId =
        query.from.id;

      console.log(
        "INLINE QUERY:",
        adminId,
        query.query
      );

      if (
        !ADMINS.includes(
          adminId
        )
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

      await bot.answerInlineQuery(
        query.id,
        [
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
                    url:
                      claimUrl
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
      console.error(
        "INLINE ERROR:",
        error
      );
    }
  }
);

// ==============================
// INLINE FEEDBACK
// ==============================

bot.on(
  "chosen_inline_result",
  async (chosen) => {
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

        console.log(
          "INLINE MESSAGE SAVED"
        );

        await syncOriginalChat(
          chosen.result_id
        );
      }

    } catch (error) {
      console.error(
        "CHOSEN INLINE ERROR:",
        error
      );
    }
  }
);

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
      if (
        startParam &&
        startParam.startsWith(
          "spin_"
        )
      ) {
        const grantToken =
          startParam.substring(5);

        const client =
          await pool.connect();

        try {
          await client.query("BEGIN");

          const grantResult =
            await client.query(
              `
              SELECT
                claimed_by,
                prize
              FROM spin_grants
              WHERE token = $1
              FOR UPDATE
              `,
              [grantToken]
            );

          if (!grantResult.rows.length) {
            await client.query("ROLLBACK");

            await bot.sendMessage(
              chatId,
              "❌ Peluang SPIN tidak sah."
            );

            return;
          }

          const grant =
            grantResult.rows[0];

          if (
            grant.claimed_by ===
              null
          ) {
            await client.query(
              `
              UPDATE spin_grants
              SET
                claimed_by = $2,
                claimed_at = NOW()
              WHERE token = $1
              `,
              [
                grantToken,
                chatId
              ]
            );

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
              `,
              [chatId]
            );

          } else if (
            String(grant.claimed_by) !==
            String(chatId)
          ) {
            await client.query("ROLLBACK");

            await bot.sendMessage(
              chatId,
              "❌ Peluang SPIN ini telah digunakan."
            );

            return;
          }

          await client.query("COMMIT");

        } catch (error) {
          await client.query("ROLLBACK");

          throw error;

        } finally {
          client.release();
        }

        const balance =
          await getBalance(chatId);

        const spinUrl =
          WHEEL_URL +
          "?grant=" +
          encodeURIComponent(
            grantToken
          );

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
                      url:
                        spinUrl
                    }
                  }
                ]
              ]
            }
          }
        );

        return;
      }

      const balance =
        await getBalance(chatId);

      const pending =
        await pool.query(
          `
          SELECT token
          FROM spin_grants
          WHERE claimed_by = $1
          AND prize IS NULL
          ORDER BY claimed_at ASC
          LIMIT 1
          `,
          [chatId]
        );

      let options = undefined;

      if (pending.rows.length) {
        const token =
          pending.rows[0].token;

        const spinUrl =
          WHEEL_URL +
          "?grant=" +
          encodeURIComponent(
            token
          );

        options = {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    "🎡 SPIN NOW",
                  web_app: {
                    url:
                      spinUrl
                  }
                }
              ]
            ]
          }
        };
      }

      await bot.sendMessage(
        chatId,
        `🎡 UWIN LUCKY WHEEL\n\nPeluang SPIN anda: ${balance}`,
        options
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
// ==============================

bot.onText(
  /\/add\s+(\d+)/,
  async (msg, match) => {
    if (
      !ADMINS.includes(
        msg.from.id
      )
    ) {
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

      await bot.sendMessage(
        msg.chat.id,
        `✅ +1 SPIN\nCustomer ID: ${customerId}\nBaki SPIN: ${result.rows[0].spins}`
      );

    } catch (error) {
      console.error(
        "ADD ERROR:",
        error
      );
    }
  }
);

// ==============================
// TELEGRAM WEBHOOK
// 有正确 secret 才接受
// ==============================

app.post(
  WEBHOOK_PATH,
  (req, res) => {
    try {
      const receivedSecret =
        req.get(
          "X-Telegram-Bot-Api-Secret-Token"
        );

      if (
        !WEBHOOK_SECRET ||
        receivedSecret !==
          WEBHOOK_SECRET
      ) {
        console.warn(
          "BLOCKED INVALID WEBHOOK REQUEST"
        );

        return res.sendStatus(403);
      }

      bot.processUpdate(
        req.body
      );

      res.sendStatus(200);

    } catch (error) {
      console.error(
        "WEBHOOK ERROR:",
        error
      );

      res.sendStatus(500);
    }
  }
);

app.get("/", (req, res) => {
  res.send(
    "Uwin Lucky Wheel Bot is running!"
  );
});

// ==============================
// START
// ==============================

app.listen(
  PORT,
  async () => {
    console.log(
      `Server running on port ${PORT}`
    );

    try {
      await initDatabase();

      const response =
        await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                url:
                  WEBHOOK_URL,

                secret_token:
                  WEBHOOK_SECRET,

                allowed_updates: [
                  "message",
                  "inline_query",
                  "chosen_inline_result",
                  "callback_query"
                ],

                drop_pending_updates:
                  true
              })
          }
        );

      const result =
        await response.json();

      console.log(
        "SET WEBHOOK:",
        result
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