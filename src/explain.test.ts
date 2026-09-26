import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { explainFile, explainProject } from "./explain.js";

test("explains detected project structure and a service without inventing relationships", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs-explain-"));
  try {
    await mkdir(join(root, "src", "routes"), { recursive: true });
    await mkdir(join(root, "src", "controllers"), { recursive: true });
    await mkdir(join(root, "src", "services"), { recursive: true });
    await mkdir(join(root, "src", "repositories"), { recursive: true });
    await writeFile(join(root, "README.md"), "# Student Management API\n\nA student management API.\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { express: "^5", sequelize: "^6", stripe: "^18", jsonwebtoken: "^9", mysql2: "^3" } }));
    await writeFile(join(root, "src", "routes", "payment.ts"), 'import { PaymentController } from "../controllers/payment.js";\nconst router = Router();\nrouter.post("/payments", PaymentController.create);\n');
    await writeFile(join(root, "src", "controllers", "payment.ts"), 'import { PaymentService } from "../services/payment.js";\nexport class PaymentController { static create() { return PaymentService; } }\n');
    await writeFile(join(root, "src", "controllers", "webhook.ts"), 'import { PaymentService } from "../services/payment.js";\nexport class WebhookController { static receive() { return PaymentService; } }\n');
    await writeFile(join(root, "src", "services", "notification.ts"), 'export class NotificationService {}\n');
    const paymentPath = join(root, "src", "services", "payment.ts");
    await writeFile(paymentPath, 'import Stripe from "stripe";\nimport { PaymentRepository } from "../repositories/payment.js";\nimport { NotificationService } from "./notification.js";\nconst stripe = new Stripe("test-key");\n/** Handles payment creation and verification. */\nexport class PaymentService { createPayment() { return stripe.paymentIntents.create({}); } verifyPayment() { return PaymentRepository; } notify() { return NotificationService; } }\n');
    await writeFile(join(root, "src", "repositories", "payment.ts"), 'export class PaymentRepository { async find() { return db.query("SELECT * FROM payments JOIN transactions ON transactions.payment_id = payments.id"); } }\n');
    await writeFile(join(root, "src", "auth.ts"), 'import jwt from "jsonwebtoken";\nexport const verify = (token: string) => jwt.verify(token, "secret");\n');
    await writeFile(join(root, "src", "db.ts"), 'import mysql from "mysql2";\nexport const connection = mysql.createConnection({});\n');
    await writeFile(join(root, "src", "models.ts"), 'import { DataTypes } from "sequelize";\nexport const Payment = sequelize.define("Payment", { id: { type: DataTypes.INTEGER, primaryKey: true } });\n');

    const project = await explainProject(root);
    assert.match(project, /A student management API\./);
    assert.match(project, /• 1 API endpoints/);
    assert.match(project, /• 1 database models/);
    assert.match(project, /• 2 services/);
    assert.match(project, /• 1 external integrations/);
    assert.match(project, /JWT authentication code/);
    assert.match(project, /MySQL driver or dialect/);
    assert.match(project, /Express routes\n  ↓\nControllers\n  ↓\nServices/);

    const payment = await explainFile(paymentPath, root);
    assert.match(payment, /^PaymentService\n/);
    assert.match(payment, /PURPOSE\nHandles payment creation and verification\./);
    assert.match(payment, /USED BY\n• PaymentController\n• WebhookController/);
    assert.match(payment, /DEPENDS ON[\s\S]*• PaymentRepository[\s\S]*• NotificationService[\s\S]*• Stripe/);
    assert.match(payment, /DATABASE[\s\S]*• payments[\s\S]*• transactions/);
    assert.match(payment, /EXTERNAL CALLS\n• Stripe PaymentIntent API/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("file explanation reports missing evidence plainly", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs-explain-"));
  try {
    const file = join(root, "apiendpoint.ts");
    await writeFile(file, 'export function health() { return "ok"; }\n');
    const output = await explainFile(file, root);
    assert.match(output, /^apiendpoint\n/);
    assert.match(output, /No local imports found/);
    assert.match(output, /No recognized external SDK calls detected/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
