import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { explainFile, explainProject } from "./explain.js";
import { inspectPython, pythonExplanation } from "./python.js";

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

const llmService = `from google import genai
from google.genai import types
from typing import (
    List, Dict, Optional, Tuple,
)
import json
import re
from config import get_settings

settings = get_settings()

class LLMService:
    """Chat completions using Google Gemini; embeddings are handled elsewhere."""
    def __init__(self):
        self.client = genai.Client(api_key=settings.gemini_api_key)
        self.chat_model = "gemini-2.5-flash"

    def _build_context_text(self, context: List[Dict], max_chars: int = 24000) -> str:
        """Build deduplicated, relevance-ranked context within the token budget."""
        return str(context)[:max_chars]

    def generate_chart_data(self, query: str, context: List[Dict]) -> Optional[Dict]:
        """Generate chart data based on query and context."""
        prompt = """Use data from the Office documents, not from Other chunks.
from pretend_database import fake_table
cursor.execute('SELECT * FROM hallucinated_table')
class FakeService:
    def fake_method(self): pass
"""
        context_text = self._build_context_text(context)
        response = self.client.models.generate_content(
            model=self.chat_model, contents=context_text,
            config=types.GenerateContentConfig(system_instruction=prompt),
        )
        return json.loads(response.text)

    async def generate_answer(
        self, query: str, context: List[Dict],
        conversation_history: List[Dict] = None,
    ) -> Tuple[str, Optional[Dict]]:
        """Generate an answer with retrieved context and an optional chart.

        Args:
            query: User question.
        """
        context_text = self._build_context_text(context)
        response = self.client.models.generate_content(model=self.chat_model, contents=context_text)
        chart = self.generate_chart_data(query, context)
        return response.text, chart

    def chunk_text(self, text: str) -> List[str]:
        """Split text into chunks for embedding."""
        return [text[:settings.chunk_size - settings.chunk_overlap]]

llm_service = LLMService()
`;

test("explains Python Gemini services, settings, typed operations and project importers", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs-python-"));
  try {
    await mkdir(join(root, "backend", "services"), { recursive: true });
    await mkdir(join(root, "backend", "api"), { recursive: true });
    const target = join(root, "backend", "services", "llm_service.py");
    await writeFile(target, llmService);
    await writeFile(join(root, "backend", "config.py"), "def get_settings(): pass\n");
    await writeFile(join(root, "backend", "api", "chat.py"), "from ..services.llm_service import llm_service\n");
    await writeFile(join(root, "backend", "api", "charts.py"), "from services import llm_service as generator\n");
    await writeFile(join(root, "app.py"), "import backend.services.llm_service as llm\n");
    const output = await explainFile(target, root);
    assert.match(output, /^LLMService\n/);
    assert.match(output, /PURPOSE\nChat completions using Google Gemini/);
    assert.match(output, /generate_answer\(query: str, context: List\[Dict\], conversation_history: List\[Dict\] = \.\.\.\) -> Tuple\[str, Optional\[Dict\]\]/);
    assert.match(output, /Build deduplicated, relevance-ranked context/);
    assert.match(output, /backend\/api\/chat\.py/);
    assert.match(output, /backend\/api\/charts\.py/);
    assert.match(output, /• app\.py/);
    assert.match(output, /typing \(List, Dict, Optional, Tuple\)/);
    assert.match(output, /config \(get_settings\)/);
    assert.match(output, /Google Gemini: self.client.models.generate_content \(in generate_answer\)/);
    assert.match(output, /self.chat_model = gemini-2.5-flash/);
    assert.match(output, /settings.gemini_api_key/);
    assert.match(output, /settings.chunk_size/);
    assert.match(output, /llm_service = LLMService\(\)/);
    assert.match(output, /DATABASE\nNo SQL or table declarations detected/);
    assert.doesNotMatch(output, /hallucinated_table|FakeService|fake_method|pretend_database|Indentation appears/);
    const project = await explainProject(root);
    assert.match(project, /• 1 services/);
    assert.match(project, /• 1 external integrations/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("database references require SQL execution or explicit ORM table declarations", () => {
  const source = `from google import genai
from typing import List
from sqlalchemy import Table as SqlTable

"""Copy data from the database and from Other chunks."""
example = "SELECT * FROM merely_documented"
orders = SqlTable("orders", metadata)

class Payment:
    __tablename__ = "payments"

def load(cursor):
    sql = "SELECT id, amount FROM payments JOIN transactions ON payments.id = transactions.payment_id"
    cursor.execute(sql)
    cursor.execute("UPDATE orders SET status = ?", ("paid",))
    # cursor.execute("SELECT * FROM comment_only")
`;
  const insight = inspectPython({ path: "repository.py", source });
  assert.deepEqual([...insight.tables].sort(), ["orders", "payments", "transactions"]);
  const output = pythonExplanation({ path: "services/payment.py", source: "from .. import repository\n" }, [{ path: "repository.py", source }]);
  assert.match(output, /payments \(via repository.py\)/);
  assert.doesNotMatch(output, /merely_documented|comment_only/);
});

test("tolerates indentation loss and masks prompt text, comments and secret defaults", () => {
  const source = llmService.replace(/^ +/gm, "");
  const output = pythonExplanation({ path: "llm_service.py", source }, []);
  assert.match(output, /Indentation appears incomplete/);
  assert.match(output, /Google Gemini: self.client.models.generate_content \(in generate_answer\)/);
  assert.doesNotMatch(output, /hallucinated_table|FakeService|fake_method/);
  const aliased = inspectPython({ path: "client.py", source: `import google.genai
from openai import OpenAI as AI
client = AI()
def answer(query: str, api_key: str = "secret-marker"):
    """Produce an answer."""
    return client.responses.create(input=query)
` });
  assert.deepEqual(aliased.externalCalls, ["OpenAI: client.responses.create (in answer)"]);
  assert.doesNotMatch(aliased.operations.join("\n"), /secret-marker/);
});

test("ordinary prose does not become database tables for other file types", async () => {
  const root = await mkdtemp(join(tmpdir(), "autodocs-prose-"));
  try {
    for (const extension of ["ts", "php"]) {
      const file = join(root, `example.${extension}`);
      await writeFile(file, 'const prompt = "Context from the Office and from Other chunks";');
      const output = await explainFile(file, root);
      assert.match(output, /DATABASE\nNo direct or one-hop table references detected/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
