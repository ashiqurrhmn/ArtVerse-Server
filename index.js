const express = require("express");
const dontenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dontenv.config();

const uri = process.env.MONGODB_URI;

const app = express();
const PORT = process.env.PORT;

app.use(
  cors({
    credentials: true,
    origin: [process.env.CLIENT_URL],
  }),
);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("art-verse");
    const artworksCollection = db.collection("artworks");

    app.post("/api/artworks", async (req, res) => {
      const artwork = req.body;
      const result = await artworksCollection.insertOne(artwork);
      res.send(result);
    });

    app.get("/api/artworks", async (req, res) => {
      const result = await artworksCollection.find().toArray();
      res.send(result);
    });

    app.get("/api/artworks/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await artworksCollection.findOne(query);
      res.send(result);
    });

    app.delete("/api/artworks/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await artworksCollection.deleteOne(query);
      res.send(result);
    });

    app.patch("/api/artworks/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updatedArtwork = req.body;
      const updateDoc = {
        $set: updatedArtwork,
      };
      const result = await artworksCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    // ── Profiles ──
    const profilesCollection = db.collection("profiles");

    app.get("/api/profiles/:email", async (req, res) => {
      const email = req.params.email;
      const result = await profilesCollection.findOne({ email });
      res.send(result || {});
    });

    app.put("/api/profiles/:email", async (req, res) => {
      const email = req.params.email;
      const profileData = req.body;
      const result = await profilesCollection.updateOne(
        { email },
        { $set: { ...profileData, email, updatedAt: new Date() } },
        { upsert: true }
      );
      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Server is running fine!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
