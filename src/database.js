import { MongoClient } from 'mongodb';

export function createDatabase({ mongoUri, dbName }) {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5_000 });
  const db = client.db(dbName);
  const collections = {
    posts: db.collection('posts'),
    comments: db.collection('comments'),
    reactions: db.collection('reactions'),
    portfolioSettings: db.collection('portfolio_settings'),
    projects: db.collection('projects'),
    certifications: db.collection('certifications'),
    skills: db.collection('skills'),
    education: db.collection('education'),
  };

  const ping = () => db.command({ ping: 1 }, { timeoutMS: 2_000 });

  return {
    client,
    db,
    collections,
    ping,
    async connect({ prepareIndexes = true } = {}) {
      await client.connect();
      await ping();
      if (prepareIndexes) {
        await collections.posts.createIndex({ slug: 1 }, { unique: true });
        await collections.reactions.createIndex({ postId: 1, visitorId: 1 }, { unique: true });
        await collections.comments.createIndex({ status: 1, createdAt: -1 });
        await collections.comments.createIndex({ postId: 1, status: 1, createdAt: -1 });
      }
    },
    close: () => client.close(),
  };
}
