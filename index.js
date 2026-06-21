const express = require("express");
const dontenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dontenv.config();

const uri = process.env.MONGODB_URI;

const app = express();
const PORT = process.env.PORT;

const Stripe = require("stripe");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");
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

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
);

const verifyToken = async (req, res, next) => {
  const authHeader = req?.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);
    next();
  } catch (err) {
    return res.status(401).json({ message: "Unauthorized" });
  }
};

async function run() {
  try {
    await client.connect();

    const db = client.db("art-verse");
    const artworksCollection = db.collection("artworks");

    // Create a new artwork
    app.post("/api/artworks", verifyToken, async (req, res) => {
      const artwork = req.body;
      const result = await artworksCollection.insertOne(artwork);
      res.send(result);
    });

    // Get all artworks, optionally filtered by artist email. Includes artist's profile data.
    app.get("/api/artworks",  async (req, res) => {
      const { email } = req.query;
      const matchStage = email ? { $match: { email } } : { $match: {} };

      const result = await artworksCollection
        .aggregate([
          matchStage,
          {
            $lookup: {
              from: "profiles",
              localField: "email",
              foreignField: "email",
              as: "artistProfile",
            },
          },
          {
            $addFields: {
              userName: { $arrayElemAt: ["$artistProfile.name", 0] },
              artistImage: { $arrayElemAt: ["$artistProfile.profileImage", 0] },
            },
          },
          {
            $project: {
              artistProfile: 0,
            },
          },
        ])
        .toArray();
      res.send(result);
    });

    // Get featured artworks (6 random published artworks)
    app.get("/api/artworks/featured", async (req, res) => {
      try {
        const result = await artworksCollection
          .aggregate([
            { $match: { status: "Published" } },
            { $sample: { size: 6 } },
            {
              $lookup: {
                from: "profiles",
                localField: "email",
                foreignField: "email",
                as: "artistProfile",
              },
            },
            {
              $addFields: {
                userName: { $arrayElemAt: ["$artistProfile.name", 0] },
                artistImage: { $arrayElemAt: ["$artistProfile.profileImage", 0] },
              },
            },
            {
              $project: {
                artistProfile: 0,
              },
            },
          ])
          .toArray();
        res.send(result);
      } catch (error) {
        console.error("Error fetching featured artworks:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // Get a specific artwork by its ID. Includes artist's profile data.
    app.get("/api/artworks/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await artworksCollection
        .aggregate([
          { $match: query },
          {
            $lookup: {
              from: "profiles",
              localField: "email",
              foreignField: "email",
              as: "artistProfile",
            },
          },
          {
            $addFields: {
              userName: { $arrayElemAt: ["$artistProfile.name", 0] },
              artistImage: { $arrayElemAt: ["$artistProfile.profileImage", 0] },
            },
          },
          {
            $project: {
              artistProfile: 0,
            },
          },
        ])
        .toArray();
      res.send(result[0] || null);
    });

    // Delete a specific artwork by its ID
    app.delete("/api/artworks/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await artworksCollection.deleteOne(query);
      res.send(result);
    });

    // Partially update a specific artwork by its ID
    app.patch("/api/artworks/:id", verifyToken, async (req, res) => {
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
      let result = await profilesCollection.findOne({ email });

      // Fetch user role from usersCollection to pass to frontend
      const user = await db.collection("user").findOne({ email });
      const role = user?.role || "user";

      if (!result) {
        result = { email, role };
      } else {
        result.role = role;
      }

      // Dynamically calculate actual sales (itemsSold) for this artist
      const artistArtworks = await artworksCollection.find({ email }).toArray();
      const artworkIds = artistArtworks.map((a) => a._id.toString());
      const salesCount = await purchasesCollection.countDocuments({
        artworkId: { $in: artworkIds },
      });
      result.itemsSold = salesCount;

      if (result && result.followers && result.followers.length > 0) {
        const followerEmails = result.followers.map((f) => f.email);
        // Fetch live profiles for all followers
        const liveProfiles = await profilesCollection
          .find({ email: { $in: followerEmails } })
          .toArray();

        // Enrich the followers array with live name and profileImage
        result.followers = result.followers.map((f) => {
          const liveProfile = liveProfiles.find((p) => p.email === f.email);
          if (liveProfile) {
            return {
              ...f,
              name: liveProfile.name || f.name,
              image: liveProfile.profileImage || f.image,
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
        { upsert: true },
      );

      // If name is updated, also update it in the user collection
      if (profileData.name) {
        await db
          .collection("user")
          .updateOne({ email }, { $set: { name: profileData.name } });

        // Also update the artist's name in their artworks
        await db
          .collection("artworks")
          .updateMany({ email }, { $set: { userName: profileData.name } });
      }

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

      const isFollowing = profile.followers?.some(
        (f) => f.email === followerData.email,
      );

      let result;
      if (isFollowing) {
        // Unfollow
        result = await profilesCollection.updateOne(
          { email: artistEmail },
          { $pull: { followers: { email: followerData.email } } },
        );
      } else {
        // Follow
        result = await profilesCollection.updateOne(
          { email: artistEmail },
          { $addToSet: { followers: followerData } },
        );
      }

      res.send({ success: true, isFollowing: !isFollowing });
    });

    // ── Users (Manage Users) ──
    const usersCollection = db.collection("user");

    // Get all users
    app.get("/api/users", verifyToken, async (req, res) => {
      try {
        const result = await usersCollection
          .aggregate([
            {
              $lookup: {
                from: "profiles",
                localField: "email",
                foreignField: "email",
                as: "userProfile",
              },
            },
            {
              $addFields: {
                profileName: { $arrayElemAt: ["$userProfile.name", 0] },
                profileImage: {
                  $arrayElemAt: ["$userProfile.profileImage", 0],
                },
              },
            },
            {
              $project: {
                userProfile: 0,
              },
            },
          ])
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch users" });
      }
    });

    // Update user role
    app.patch("/api/users/:id/role", verifyToken, async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;

      try {
        // better-auth often uses string _id
        let result = await usersCollection.updateOne(
          { _id: id },
          { $set: { role: role } },
        );

        if (result.matchedCount === 0) {
          // Fallback to ObjectId just in case
          result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role: role } },
          );
        }
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to update role" });
      }
    });

    // Delete a user
    app.delete("/api/users/:id", verifyToken, async (req, res) => {
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

    // Admin Stats Endpoint
    app.get("/api/admin/stats", verifyToken, async (req, res) => {
      try {
        const totalUsers = await usersCollection.countDocuments();
        const totalArtists = await usersCollection.countDocuments({
          role: "artist",
        });

        const allPurchases = await db.collection("purchases").find().toArray();
        const artworksSold = allPurchases.length;
        const totalRevenue = allPurchases.reduce(
          (acc, p) => acc + (p.amount || 0),
          0,
        );

        // Group sales by month
        const months = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ];
        const salesByMonth = {};
        months.forEach((m) => (salesByMonth[m] = 0));

        allPurchases.forEach((p) => {
          if (p.purchasedAt) {
            const date = new Date(p.purchasedAt);
            const monthName = months[date.getMonth()];
            salesByMonth[monthName] += p.amount || 0;
          }
        });

        const salesData = months.map((name) => ({
          name,
          sales: salesByMonth[name],
        }));

        // Artworks by category
        const allArtworks = await artworksCollection
          .find({}, { projection: { category: 1 } })
          .toArray();
        const categoryCounts = {};
        allArtworks.forEach((a) => {
          const cat = a.category || "Uncategorized";
          categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
        });

        const categoryData = Object.keys(categoryCounts).map((name) => ({
          name,
          value: categoryCounts[name],
        }));

        res.send({
          totalUsers,
          totalArtists,
          artworksSold,
          totalRevenue,
          salesData,
          categoryData,
        });
      } catch (error) {
        console.error("Failed to fetch admin stats:", error);
        res.status(500).send({ error: "Failed to fetch admin stats" });
      }
    });

    //stripe
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const { title, image, price, _id, buyerEmail } = req.body;

        if (buyerEmail) {
          const buyer = await db
            .collection("user")
            .findOne({ email: buyerEmail });
          const plan = buyer?.plan || "free";
          const purchaseCount = await db
            .collection("purchases")
            .countDocuments({ buyerEmail });

          if (plan === "free" && purchaseCount >= 3) {
            return res.status(403).send({
              error:
                "Free plan allows max 3 artwork purchases. Please upgrade to Pro.",
            });
          }
          if (plan === "pro" && purchaseCount >= 9) {
            return res.status(403).send({
              error:
                "Pro plan allows max 9 artwork purchases. Please upgrade to Premium.",
            });
          }
        }

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
        const existing = await purchasesCollection.findOne({
          stripeSessionId: session_id,
        });
        if (existing) {
          return res.send({
            success: true,
            purchase: existing,
            alreadyProcessed: true,
          });
        }

        const session = await stripe.checkout.sessions.retrieve(session_id);

        if (session.payment_status === "paid") {
          const artworkId = session.metadata?.artworkId;
          const buyerEmail = session.metadata?.buyerEmail;
          const artworkTitle = session.metadata?.artworkTitle;

          if (!artworkId) {
            return res
              .status(400)
              .send({ error: "Missing artwork ID in session" });
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

          const artwork = await artworksCollection.findOne({
            _id: new ObjectId(artworkId),
          });

          // Mark artwork as sold
          await artworksCollection.updateOne(
            { _id: new ObjectId(artworkId) },
            {
              $set: {
                sold: true,
                buyerEmail: purchase.buyerEmail,
                soldAt: new Date(),
              },
            },
          );

          // Increment the artist's itemsSold in their profile
          if (artwork && artwork.email) {
            await profilesCollection.updateOne(
              { email: artwork.email },
              { $inc: { itemsSold: 1 } },
              { upsert: true },
            );
          }

          return res.send({ success: true, purchase });
        }

        res.send({ success: false, status: session.payment_status });
      } catch (error) {
        console.error("Purchase verify error:", error);
        res.status(500).send({ error: error.message });
      }
    });

    // Get purchases for a buyer
    app.get("/api/purchases", verifyToken, async (req, res) => {
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
              artwork = await artworksCollection.findOne({
                _id: new ObjectId(p.artworkId),
              });
            } catch (e) {
              /* ignore */
            }
            return {
              ...p,
              artwork: artwork
                ? {
                    title: artwork.title,
                    image: artwork.image,
                    userName: artwork.userName,
                    userEmail: artwork.email,
                    category: artwork.category,
                  }
                : null,
            };
          }),
        );

        res.send(enriched);
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch purchases" });
      }
    });

    // Get all purchases for admin
    app.get("/api/admin/purchases", verifyToken, async (req, res) => {
      try {
        const allPurchases = await purchasesCollection
          .find({})
          .sort({ purchasedAt: -1 })
          .toArray();

        // Enrich with artwork data and buyer profiles
        const enriched = await Promise.all(
          allPurchases.map(async (p) => {
            let artwork = null;
            let buyerProfile = null;
            try {
              if (p.artworkId) {
                artwork = await artworksCollection.findOne({
                  _id: new ObjectId(p.artworkId),
                });
              }
            } catch (e) {}
            if (p.buyerEmail) {
              buyerProfile = await profilesCollection.findOne({
                email: p.buyerEmail,
              });
            }
            return {
              id: p.stripeSessionId || p._id.toString(),
              buyerName:
                buyerProfile?.name || p.buyerEmail?.split("@")[0] || "Unknown",
              buyerEmail: p.buyerEmail || "Unknown",
              buyerAvatar: buyerProfile?.profileImage || null,
              artworkTitle: artwork ? artwork.title : p.artworkTitle,
              artistName: artwork
                ? artwork.userName || artwork.artist
                : "Unknown",
              artistEmail: artwork ? artwork.email : "Unknown",
              amount: p.amount,
              date: new Date(p.purchasedAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
              }),
              status: "Completed",
            };
          }),
        );
        res.send(enriched);
      } catch (error) {
        console.error("Failed to fetch all purchases:", error);
        res.status(500).send({ error: "Failed to fetch all purchases" });
      }
    });

    // ── Subscriptions ──
    const subscriptionsCollection = db.collection("subscriptions");

    // Get all subscription "purchases" for admin
    app.get("/api/admin/subscriptions", verifyToken, async (req, res) => {
      try {
        const subscriptionsData = await subscriptionsCollection
          .find()
          .sort({ createdAt: -1 })
          .toArray();

        const enrichedSubscriptions = await Promise.all(
          subscriptionsData.map(async (sub) => {
            const resolvedEmail =
              sub.buyerEmail ||
              sub.email ||
              sub.customer_email ||
              sub.customer_details?.email ||
              sub.metadata?.buyerEmail ||
              sub.userEmail ||
              "Unknown";
            const profile = await profilesCollection.findOne({
              email: resolvedEmail,
            });
            return {
              id:
                sub.transactionId ||
                sub.stripeSessionId ||
                sub.id ||
                sub._id.toString(),
              name:
                profile?.name || sub.buyerName || resolvedEmail.split("@")[0],
              email: resolvedEmail,
              type: "Subscription",
              plan: sub.plan || sub.metadata?.plan || "Premium",
              amount:
                sub.amount ||
                (sub.amount_total ? sub.amount_total / 100 : null) ||
                (sub.plan === "pro" ? 15 : 30),
              date: new Date(
                sub.createdAt ||
                  sub.purchasedAt ||
                  (sub.created ? sub.created * 1000 : null) ||
                  parseInt(sub._id.toString().substring(0, 8), 16) * 1000,
              ).toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
              }),
            };
          }),
        );
        res.send(enrichedSubscriptions);
      } catch (error) {
        console.error("Failed to fetch subscriptions:", error);
        res.status(500).send({ error: "Failed to fetch subscriptions" });
      }
    });

    // Get sales for an artist
    app.get("/api/sales/:email", verifyToken, async (req, res) => {
      try {
        const email = req.params.email;
        if (!email) {
          return res.status(400).send({ error: "Email is required" });
        }

        // Find all artworks by this artist
        const artistArtworks = await artworksCollection
          .find({ email })
          .toArray();
        const artworkIds = artistArtworks.map((a) => a._id.toString());

        // Find all purchases for these artworks
        const sales = await purchasesCollection
          .find({ artworkId: { $in: artworkIds } })
          .sort({ purchasedAt: -1 })
          .toArray();

        // Enrich with buyer profile and formatting
        const enriched = await Promise.all(
          sales.map(async (sale) => {
            const artwork = artistArtworks.find(
              (a) => a._id.toString() === sale.artworkId,
            );

            // Get buyer profile
            let buyerProfile = null;
            if (sale.buyerEmail) {
              buyerProfile = await profilesCollection.findOne({
                email: sale.buyerEmail,
              });
            }

            return {
              id: sale.stripeSessionId || sale._id.toString(),
              title: artwork ? artwork.title : sale.artworkTitle,
              buyerName:
                buyerProfile?.name ||
                (sale.buyerEmail ? sale.buyerEmail.split("@")[0] : "Unknown"),
              buyerEmail: sale.buyerEmail || "Unknown",
              buyerAvatar: buyerProfile?.profileImage || null,
              date: new Date(sale.purchasedAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
              }),
              amount: sale.amount,
              status: "Completed",
            };
          }),
        );
        res.send(enriched);
      } catch (error) {
        console.error("Failed to fetch sales:", error);
        res.status(500).send({ error: "Failed to fetch sales" });
      }
    });

    // Check if an artwork is sold
    app.get("/api/purchases/check/:artworkId", async (req, res) => {
      try {
        const { artworkId } = req.params;
        const artwork = await artworksCollection.findOne({
          _id: new ObjectId(artworkId),
        });
        res.send({
          sold: artwork?.sold === true,
          buyerEmail: artwork?.buyerEmail || null,
        });
      } catch (error) {
        res.send({ sold: false });
      }
    });

    // Get purchase stats for a buyer
    app.get("/api/purchases/stats/:email", async (req, res) => {
      try {
        const email = req.params.email;
        if (!email) {
          return res.status(400).send({ error: "Email is required" });
        }
        const buyer = await usersCollection.findOne({ email });
        const plan = buyer?.plan || "free";
        const count = await purchasesCollection.countDocuments({
          buyerEmail: email,
        });

        let limit = 3;
        if (plan === "pro") limit = 9;
        if (plan === "premium") limit = -1; // unlimited

        res.send({ plan, count, limit });
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch stats" });
      }
    });

    // ── Saved Artworks ──
    const savedArtworksCollection = db.collection("savedArtworks");

    // Toggle save/unsave artwork
    app.post("/api/saved-artworks/toggle", verifyToken, async (req, res) => {
      const { email, artworkId } = req.body;
      
      try {
        const query = { email, artworkId: new ObjectId(artworkId) };
        const existing = await savedArtworksCollection.findOne(query);

        if (existing) {
          // Unsave
          await savedArtworksCollection.deleteOne(query);
          res.send({ saved: false });
        } else {
          // Save
          await savedArtworksCollection.insertOne({
            email,
            artworkId: new ObjectId(artworkId),
            savedAt: new Date(),
          });
          res.send({ saved: true });
        }
      } catch (error) {
        console.error("Error toggling save:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // Check if an artwork is saved by a user
    app.get("/api/saved-artworks/check/:email/:artworkId", async (req, res) => {
      const { email, artworkId } = req.params;
      
      try {
        const existing = await savedArtworksCollection.findOne({
          email,
          artworkId: new ObjectId(artworkId),
        });
        res.send({ saved: !!existing });
      } catch (error) {
        console.error("Error checking saved status:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // Get all saved artworks for a user (with details)
    app.get("/api/saved-artworks/:email", verifyToken, async (req, res) => {
      try {
        const { email } = req.params;
        const savedItems = await savedArtworksCollection
          .find({ email })
          .sort({ savedAt: -1 })
          .toArray();

        const enriched = await Promise.all(
          savedItems.map(async (item) => {
            let artwork = null;
            try {
              artwork = await artworksCollection.findOne({
                _id: new ObjectId(item.artworkId),
              });
            } catch (e) {}
            return artwork;
          }),
        );

        // filter out nulls in case an artwork was deleted
        res.send(enriched.filter((a) => a !== null));
      } catch (error) {
        res.status(500).send({ error: "Failed to fetch saved artworks" });
      }
    });

    // ── Comments ──
    const commentsCollection = db.collection("comments");

    // Get all comments for an artwork (public)
    app.get("/api/artworks/:id/comments", async (req, res) => {
      try {
        const artworkId = req.params.id;
        const comments = await commentsCollection
          .find({ artworkId })
          .sort({ createdAt: -1 })
          .toArray();

        // Enrich with profile data
        const enriched = await Promise.all(
          comments.map(async (comment) => {
            const profile = await profilesCollection.findOne({
              email: comment.userId,
            });
            const userDoc = await usersCollection.findOne({
              email: comment.userId,
            });
            return {
              _id: comment._id,
              artworkId: comment.artworkId,
              userId: comment.userId,
              comment: comment.comment,
              createdAt: comment.createdAt,
              updatedAt: comment.updatedAt || null,
              userName:
                profile?.name || userDoc?.name || comment.userId.split("@")[0],
              userAvatar: profile?.profileImage || userDoc?.image || null,
            };
          }),
        );
        res.send(enriched);
      } catch (error) {
        console.error("Failed to fetch comments:", error);
        res.status(500).send({ error: "Failed to fetch comments" });
      }
    });

    // Post a comment (any logged-in user)
    app.post("/api/artworks/:id/comments", async (req, res) => {
      try {
        const artworkId = req.params.id;
        const { email, comment } = req.body;

        if (!email || !comment || !comment.trim()) {
          return res
            .status(400)
            .send({ error: "Email and comment are required" });
        }

        const newComment = {
          artworkId,
          userId: email,
          comment: comment.trim(),
          createdAt: new Date(),
        };

        const result = await commentsCollection.insertOne(newComment);

        // Return enriched comment
        const profile = await profilesCollection.findOne({ email });
        const userDoc = await usersCollection.findOne({ email });
        res.send({
          _id: result.insertedId,
          ...newComment,
          userName: profile?.name || userDoc?.name || email.split("@")[0],
          userAvatar: profile?.profileImage || userDoc?.image || null,
        });
      } catch (error) {
        console.error("Failed to post comment:", error);
        res.status(500).send({ error: "Failed to post comment" });
      }
    });

    // Edit a comment (only the original commenter)
    app.patch("/api/comments/:commentId", async (req, res) => {
      try {
        const { commentId } = req.params;
        const { email, comment } = req.body;

        if (!email || !comment || !comment.trim()) {
          return res
            .status(400)
            .send({ error: "Email and comment are required" });
        }

        const existing = await commentsCollection.findOne({
          _id: new ObjectId(commentId),
        });
        if (!existing) {
          return res.status(404).send({ error: "Comment not found" });
        }
        if (existing.userId !== email) {
          return res
            .status(403)
            .send({ error: "You can only edit your own comments" });
        }

        await commentsCollection.updateOne(
          { _id: new ObjectId(commentId) },
          { $set: { comment: comment.trim(), updatedAt: new Date() } },
        );

        res.send({ success: true });
      } catch (error) {
        console.error("Failed to edit comment:", error);
        res.status(500).send({ error: "Failed to edit comment" });
      }
    });

    // Delete a comment (only the original commenter)
    app.delete("/api/comments/:commentId", async (req, res) => {
      try {
        const { commentId } = req.params;
        const { email } = req.body;

        if (!email) {
          return res.status(400).send({ error: "Email is required" });
        }

        const existing = await commentsCollection.findOne({
          _id: new ObjectId(commentId),
        });
        if (!existing) {
          return res.status(404).send({ error: "Comment not found" });
        }
        if (existing.userId !== email) {
          return res
            .status(403)
            .send({ error: "You can only delete your own comments" });
        }

        await commentsCollection.deleteOne({ _id: new ObjectId(commentId) });
        res.send({ success: true });
      } catch (error) {
        console.error("Failed to delete comment:", error);
        res.status(500).send({ error: "Failed to delete comment" });
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
