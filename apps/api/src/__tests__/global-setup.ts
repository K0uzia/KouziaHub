export default function globalSetup() {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "file:./test.db";
}
