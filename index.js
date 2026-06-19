const express = require("express");
const dontenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dontenv.config();

const uri = process.env.MONGODB_URI;

const app = express();
const PORT = process.env.PORT;

const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

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

    // Create a new artwork
    app.post("/api/artworks", async (req, res) => {
      const artwork = req.body;
      const result = await artworksCollection.insertOne(artwork);
      res.send(result);
    });

    // Get all artworks, optionally filtered by artist email. Includes artist's profile data.
    app.get("/api/artworks", async (req, res) => {
      const { email } = req.query;
      const matchStage = email ? { $match: { email } } : { $match: {} };

      const result = await artworksCollection.aggregate([
        matchStage,
        {
          $lookup: {
            from: "profiles",
            localField: "email",
            foreignField: "email",
            as: "artistProfile"
          }
        },
        {
          $addFields: {
            userName: { $arrayElemAt: ["$artistProfile.name", 0] },
            artistImage: { $arrayElemAt: ["$artistProfile.profileImage", 0] }
          }
        },
        {
          $project: {
            artistProfile: 0
          }
        }
      ]).toArray();
      res.send(result);
    });

    // Get a specific artwork by its ID. Includes artist's profile data.
    app.get("/api/artworks/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await artworksCollection.aggregate([
        { $match: query },
        {
          $lookup: {
            from: "profiles",
            localField: "email",
            foreignField: "email",
            as: "artistProfile"
          }
        },
        {
          $addFields: {
            userName: { $arrayElemAt: ["$artistProfile.name", 0] },
            artistImage: { $arrayElemAt: ["$artistProfile.profileImage", 0] }
          }
        },
        {
          $project: {
            artistProfile: 0
          }
        }
      ]).toArray();
      res.send(result[0] || null);
    });

    // Delete a specific artwork by its ID
    app.delete("/api/artworks/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await artworksCollection.deleteOne(query);
      res.send(result);
    });

    // Partially update a specific artwork by its ID
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

    // Get a user profile by email and fetch live profile data for their followers
    app.get("/api/profiles/:email", async (req, res) => {
      const email = req.params.email;
      const result = await profilesCollection.findOne({ email });
      
      if (result && result.followers && result.followers.length > 0) {
        const followerEmails = result.followers.map(f => f.email);
        // Fetch live profiles for all followers
        const liveProfiles = await profilesCollection.find({ email: { $in: followerEmails } }).toArray();
        
        // Enrich the followers array with live name and profileImage
        result.followers = result.followers.map(f => {
          const liveProfile = liveProfiles.find(p => p.email === f.email);
          if (liveProfile) {
            return {
              ...f,
              name: liveProfile.name || f.name,
              image: liveProfile.profileImage || f.image
            };
          }
          return f;
        });
      }
      
      res.send(result || {});
    });

    // Create or update a user profile by email (upsert operation)
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

    // Toggle follow/unfollow status for a specific artist's profile
    app.post("/api/profiles/:email/follow", async (req, res) => {
      const artistEmail = req.params.email;
      const followerData = req.body; 

      if (!followerData.email) {
        return res.status(400).send({ error: "Follower email is required" });
      }

      const profile = await profilesCollection.findOne({ email: artistEmail });
      
      // Ensure profile exists
      if (!profile) {
        return res.status(404).send({ error: "Profile not found" });
      }

      const isFollowing = profile.followers?.some((f) => f.email === followerData.email);

      let result;
      if (isFollowing) {
        // Unfollow
        result = await profilesCollection.updateOne(
          { email: artistEmail },
          { $pull: { followers: { email: followerData.email } } }
        );
      } else {
        // Follow
        result = await profilesCollection.updateOne(
          { email: artistEmail },
          { $addToSet: { followers: followerData } }
        );
      }

      res.send({ success: true, isFollowing: !isFollowing });
    });

    // ── Users (Manage Users) ──
    const usersCollection = db.collection("user");

    // Get all users
    app.get("/api/users", async (req, res) => {
      try {
        const result = await usersCollection.aggregate([
          {
            $lookup: {
              from: "profiles",
              localField: "email",
              foreignField: "email",
              as: "userProfile"
            }
          },
          {
            $addFields: {
              profileName: { $arrayElemAt: ["$userProfile.name", 0] },
              profileImage: { $arrayElemAt: ["$userProfile.profileImage", 0] }
            }
          },
          {
            $project: {
              userProfile: 0
            }
          }
        ]).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch users" });
      }
    });

    // Update user role
    app.patch("/api/users/:id/role", async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;
      
      try {
        // better-auth often uses string _id
        let result = await usersCollection.updateOne(
          { _id: id },
          { $set: { role: role } }
        );
        
        if (result.matchedCount === 0) {
          // Fallback to ObjectId just in case
          result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role: role } }
          );
        }
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to update role" });
      }
    });

    // Delete a user
    app.delete("/api/users/:id", async (req, res) => {
      const id = req.params.id;
      
      try {
        let result = await usersCollection.deleteOne({ _id: id });
        if (result.deletedCount === 0) {
          result = await usersCollection.deleteOne({ _id: new ObjectId(id) });
        }
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to delete user" });
      }
    });


    //stripe
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const { title, image, price, _id, buyerEmail } = req.body;

        const session = await stripe.checkout.sessions.create({
          customer_email: buyerEmail,
          
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: title,
                  images: image ? [image] : [],
                },
                unit_amount: Math.round(price * 100),
              },
              quantity: 1,
            },
          ],
          metadata: {
            artworkId: _id,
            buyerEmail: buyerEmail || "",
            artworkTitle: title,
          },
          mode: "payment",
          success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_URL}/artworks/${_id}`,
        });

        res.send({ url: session.url });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // ── Purchases ──
    const purchasesCollection = db.collection("purchases");

    // Verify a Stripe session and save the purchase
    app.post("/api/purchases/verify", async (req, res) => {
      try {
        const { session_id } = req.body;
        if (!session_id) {
          return res.status(400).send({ error: "No session ID" });
        }

        // Check if this session was already processed
        const existing = await purchasesCollection.findOne({ stripeSessionId: session_id });
        if (existing) {
          return res.send({ success: true, purchase: existing, alreadyProcessed: true });
        }

        const session = await stripe.checkout.sessions.retrieve(session_id);

        if (session.payment_status === "paid") {
          const artworkId = session.metadata?.artworkId;
          const buyerEmail = session.metadata?.buyerEmail;
          const artworkTitle = session.metadata?.artworkTitle;

          if (!artworkId) {
            return res.status(400).send({ error: "Missing artwork ID in session" });
          }

          // Create purchase record
          const purchase = {
            artworkId,
            buyerEmail: buyerEmail || session.customer_email || "",
            artworkTitle: artworkTitle || "",
            amount: session.amount_total / 100,
            currency: session.currency,
            stripeSessionId: session_id,
            purchasedAt: new Date(),
          };

          await purchasesCollection.insertOne(purchase);

          // Mark artwork as sold
          await artworksCollection.updateOne(
            { _id: new ObjectId(artworkId) },
            { $set: { sold: true, buyerEmail: purchase.buyerEmail, soldAt: new Date() } }
          );

          return res.send({ success: true, purchase });
        }

        res.send({ success: false, status: session.payment_status });
      } catch (error) {
        console.error("Purchase verify error:", error);
        res.status(500).send({ error: error.message });
      }
    });

    // Get purchases for a buyer
    app.get("/api/purchases", async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) {
          return res.status(400).send({ error: "Email is required" });
        }
        const purchases = await purchasesCollection
          .find({ buyerEmail: email })
          .sort({ purchasedAt: -1 })
          .toArray();

        // Enrich with artwork data
        const enriched = await Promise.all(
          purchases.map(async (p) => {
            let artwork = null;
            try {
              artwork = await artworksCollection.findOne({ _id: new ObjectId(p.artworkId) });
            } catch (e) { /* ignore */ }
            return {
              ...p,
              artwork: artwork
                ? { title: artwork.title, image: artwork.image, userName: artwork.userName, category: artwork.category }
                : null,
            };
          })
        );

        res.send(enriched);
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch purchases" });
      }
    });

    // Check if an artwork is sold
    app.get("/api/purchases/check/:artworkId", async (req, res) => {
      try {
        const { artworkId } = req.params;
        const artwork = await artworksCollection.findOne({ _id: new ObjectId(artworkId) });
        res.send({ sold: artwork?.sold === true, buyerEmail: artwork?.buyerEmail || null });
      } catch (error) {
        res.send({ sold: false });
      }
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
