const express = require('express');
const app = express();
const port = 5000;
const cors = require('cors');
require('dotenv').config();
// import { ObjectId } from 'mongodb';

    // Stripe Configuration
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); 
// Middleware declarations (Must come BEFORE declaring API routes)
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello World!');
});

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { createRemoteJWKSet, jwtVerify } = require('jose-cjs');
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`));

// Token Verification Middleware
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  console.log("Auth Header:", authHeader);

  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return res.status(401).json({ msg: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ msg: "Unauthorized" });
  }

  try {
     const { payload } = await jwtVerify(token, JWKS);
    console.log("Token Payload:", payload);
      req.user = { ...payload, id: payload.sub };
   // Attach user data to request
    next();
  } catch (error) {
    console.error("JWT Verification Error:", error);
    return res.status(401).json({ msg: "Unauthorized" });
  }
};

async function run() {
  try {
    await client.connect();

    const database = client.db("RecipeHub");
    const recipescollection = database.collection("recipes");
    const paymentsCollection = database.collection("payments");
    const usersCollection = database.collection("user");
    const likesCollection = database.collection("likes");
    // ==========================================
    // ১. ইউজারের মোট রেসিপি সংখ্যা ও কারেন্ট প্ল্যান চেক করার API
    // ==========================================
app.get('/api/my-recipes/count', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const count = await recipescollection.countDocuments({ userId });

    // ✅ Convert to ObjectId
    const userQuery = ObjectId.isValid(userId)
      ? { _id: new ObjectId(userId) }
      : { _id: userId };
    const user = await usersCollection.findOne(userQuery);

    res.status(200).send({
      success: true,
      count,
      plan: user?.plan || "free"
    });
  } catch (error) {
    res.status(500).send({ error: "Failed to get recipe count" });
  }
});

    // ==========================================
    // ২. নতুন রেসিপি যোগ করার API (Free-তে ৩টি পোস্টের লিমিট ও PRO-তে আনলিমিটেড)
    // ==========================================
    app.post('/api/recipes', verifyToken, async (req, res) => {
      try {
        const userId = req.user.id;
        const userEmail = req.user.email;

        console.log("Attempting post for User ID:", userId);

        // ডাটাবেজ থেকে ইউজারের বর্তমান প্ল্যান চেক করা
        const user = await usersCollection.findOne({ 
          $or: [
            { email: userEmail },
            { _id: userId }
          ] 
        });
        
        // ডাটাবেজে এই ইউজারের বর্তমান রেসিপি সংখ্যা চেক করা
        const currentCount = await recipescollection.countDocuments({ userId: userId });

        // কন্ডিশন: প্রো না হলে এবং অলরেডি ৩টি বা তার বেশি রেসিপি থাকলে ব্লক হবে
        if (user?.plan !== 'pro' && currentCount >= 3) {
          return res.status(403).json({ 
            error: "Limit reached! You cannot post more than 3 recipes. Please pay to unlock unlimited posting." 
          });
        }

        const recipe = {
          ...req.body,
          userId
        };

        const result = await recipescollection.insertOne(recipe);
        res.status(201).send(result);
        
      } catch (error) {
        console.error("Error saving recipe:", error);
        res.status(500).send({ error: "Could not save the recipe." });
      }
    });





    // ==========================================
    // ৩. Stripe Checkout Session তৈরির API
    // ==========================================
    // app.post('/api/create-checkout-session', async (req, res) => {
    //   try {
    //     const { price, packageName } = req.body;

    //     const session = await stripe.checkout.sessions.create({
    //       payment_method_types: ['card'],
    //       line_items: [
    //         {
    //           price_data: {
    //             currency: 'usd',
    //             product_data: {
    //               name: packageName,
    //               description: 'Lifetime unlimited recipe posting access.',
    //             },
    //             unit_amount: Math.round(price * 100), 
    //           },
    //           quantity: 1,
    //         },
    //       ],
    //       mode: 'payment',
    //       // সাকসেস ইউআরএল-এ কুয়েরি প্যারামিটার যুক্ত করা হলো যাতে ফ্রন্টএন্ড সহজে ডিটেক্ট করতে পারে
    //       success_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/success?payment=success`, 
    //       cancel_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/payment?payment=cancel`,
    //     });

    //     res.status(200).json({ id: session.id, url: session.url });
    //   } catch (error) {
    //     console.error("Stripe Session Error:", error);
    //     res.status(500).json({ error: error.message });
    //   }
    // });

    app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { price, packageName, recipeId, userEmail } = req.body;

    // ১. কন্ডিশনাল সাকসেস ইউআরএল ম্যাপ করা (রেসিপি পারচেজ বনাম প্রো প্ল্যান আপগ্রেড)
    let successUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/success?payment=success`;
    let cancelUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/payment?payment=cancel`;

    if (recipeId) {
      // যদি রেসিপি পারচেজ হয়, তবে সাকসেস ইউআরএল-এ এক্সট্রা আইডি এবং টাইপ পুশ করা হচ্ছে
      successUrl += `&type=recipe&session_id={CHECKOUT_SESSION_ID}&recipeId=${recipeId}&email=${userEmail}`;
      cancelUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/api/recipes/${recipeId}`;
    }

    const sessionData = {
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: packageName,
              description: recipeId 
                ? 'Instant lifetime access to this premium recipe blueprint.' 
                : 'Lifetime unlimited recipe posting access.',
            },
            unit_amount: Math.round(price * 100), 
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
    };

    // যদি ইমেইল প্রোভাইড করা হয় তবে কাস্টমার ইমেইল অবজেক্ট অ্যাড হবে
    if (userEmail) {
      sessionData.customer_email = userEmail;
    }

    const session = await stripe.checkout.sessions.create(sessionData);
    res.status(200).json({ id: session.id, url: session.url });

  } catch (error) {
    console.error("Stripe Session Error:", error);
    res.status(500).json({ error: error.message });
  }
});


    // ==================================================
    // ৪. সফল পেমেন্টের পর ট্রানজেকশন সেভ ও প্ল্যান আপডেট API (ACTIVE)
    // ==================================================
   // ==================================================
    // ৪. সফল পেমেন্টের পর ট্রানজেকশন সেভ ও প্ল্যান আপডেট API (SECURED & FIXED)
    // ==================================================
app.post('/api/payments/confirm', verifyToken, async (req, res) => {
  try {
    const { email, amount, packageName, transactionId } = req.body;
    const userId = req.user.id; // string from token

    // 1. Save payment record
    await paymentsCollection.insertOne({
      userId,
      email: email.toLowerCase().trim(),
      amount,
      packageName,
      transactionId,
      date: new Date()
    });

    // 2. Update the user collection
    const userQuery = ObjectId.isValid(userId)
      ? { _id: new ObjectId(userId) }
      : { _id: userId };

    const updateResult = await usersCollection.updateOne(
      userQuery,
      { $set: { plan: "pro", updatedAt: new Date() } }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // 3. 🔥 Update all sessions for this user (fixed query)
    const sessionsCollection = database.collection("session");
    const sessionQuery = ObjectId.isValid(userId)
      ? { userId: new ObjectId(userId) }
      : { userId: userId };

    const sessionUpdateResult = await sessionsCollection.updateMany(
      sessionQuery,
      { $set: { "user.plan": "pro" } }
    );

    console.log(`Updated ${sessionUpdateResult.modifiedCount} session(s) for user ${userId}`);

    res.status(200).json({ success: true, message: "Plan upgraded to PRO" });
  } catch (error) {
    console.error("Payment confirmation error:", error);
    res.status(500).json({ error: error.message });
  }
});


const purchasedCollection = database.collection("purchasedRecipes");

    // ১. পেমেন্ট সাকসেস হওয়ার পর রেসিপি পারচেজ লিস্টে যোগ করার API
    app.post('/api/purchased-recipes/confirm', async (req, res) => {
      try {
        const { sessionId, recipeId, email } = req.body;
        
        // ডুপ্লিকেট এন্ট্রি চেক করা (একই সেশন আইডি বা একই ইউজার একই রেসিপি বারবার যাতে সেভ না হয়)
        const alreadyPurchased = await purchasedCollection.findOne({ sessionId });
        if (alreadyPurchased) {
          return res.status(200).json({ success: true, message: "Already processed" });
        }

        await purchasedCollection.insertOne({
          sessionId,
          recipeId,
          email: email.toLowerCase().trim(),
          purchaseDate: new Date()
        });

        res.status(200).json({ success: true, message: "Purchase confirmed successfully!" });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ২. ইউজারের ইমেইল অনুযায়ী সব কেনা রেসিপি ডাটাবেজ থেকে আনার API (Aggregation Lookup সহ)
app.get('/api/purchased-recipes/:email', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase().trim();
    
    const purchases = await purchasedCollection.aggregate([
      // ১. ইউজারের ইমেইল অনুযায়ী ফিল্টার করবে
      { $match: { email: email } },
      
      // 🎯 এখানে $group অপারেটরটি বাদ দেওয়া হয়েছে, তাই সব পারচেজ হিস্ট্রিই আসবে
      {
        $addFields: {
          recipeObjectId: { $toObjectId: "$recipeId" }
        }
      },
      // ২. রেসিপি কালেকশনের সাথে জয়েন (Lookup) করা হচ্ছে
      {
        $lookup: {
          from: "recipes",
          localField: "recipeObjectId",
          foreignField: "_id",
          as: "recipeDetails"
        }
      },
      { $unwind: "$recipeDetails" },
      // ৩. ফ্রন্টএন্ডের জন্য প্রয়োজনীয় ফিল্ডগুলো প্রজেক্ট করা হচ্ছে
      {
        $project: {
          _id: "$recipeDetails._id",
          recipeName: "$recipeDetails.recipeName",
          imageUrl: "$recipeDetails.imageUrl",
          category: "$recipeDetails.category",
          cuisineType: "$recipeDetails.cuisineType",
          purchaseDate: "$purchaseDate", // কখন কিনেছে তা ট্র্যাক করার জন্য
          sessionId: "$sessionId"         // ইউনিক ট্র্যাকিং আইডি
        }
      }
    ]).toArray();

    res.status(200).send(purchases);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});




    // ==========================================
    // ৫. Popular Recipe APIs
    // ==========================================
    const popularRecipeCollection = database.collection("popularRecipe");

    app.get('/popularRecipe', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 8;
        const result = await popularRecipeCollection
          .find({})
          .sort({ rank: 1 }) 
          .limit(limit)
          .toArray();
        res.status(200).send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch popular recipes", error: error.message });
      }
    });

    app.get('/popularRecipe/:id', async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ error: "Invalid recipe ID format" });
        }
        const result = await popularRecipeCollection.findOne({ _id: new ObjectId(id) });
        if (!result) {
          return res.status(404).send({ error: "Recipe not found" });
        }
        res.status(200).send(result);
      } catch (error) {
        res.status(500).send({ error: "Could not retrieve recipe details." });
      }
    });

    // ==========================================
    // ৬. Featured Recipe APIs
    // ==========================================
    const featuredRecipesCollection = database.collection("FeaturedRecipes");

    app.get('/FeaturedRecipes', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 3;
        const result = await featuredRecipesCollection.find({}).limit(limit).toArray();
        res.status(200).send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch featured recipes", error: error.message });
      }
    });

    app.get('/FeaturedRecipes/:id', async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ error: "Invalid featured recipe ID format" });
        }
        const query = { _id: new ObjectId(id) };
        const result = await featuredRecipesCollection.findOne(query);
        if (!result) {
          return res.status(404).send({ error: "Featured recipe not found" });
        }
        res.status(200).send(result);
      } catch (error) {
        console.error("Failed to fetch featured recipe:", error);
        res.status(500).send({ error: "Could not retrieve featured recipe details." });
      }
    });

    // ==========================================
    // ৭. User Specific & Global Recipes APIs
    // ==========================================
    app.get('/api/my-recipes/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        const result = await recipescollection.find({ userId }).toArray();
        res.status(200).send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to fetch recipes", error: error.message });
      }
    });


app.patch('/api/my-recipes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updatedData = req.body; // ফ্রন্টএন্ড থেকে পাঠানো নতুন ডাটা
    
    // MongoDB ObjectId ইম্পোর্ট করা থাকতে হবে: const { ObjectId } = require('mongodb');
    const filter = { _id: new ObjectId(id) };
    const updateDoc = {
      $set: updatedData,
    };

    const result = await recipescollection.updateOne(filter, updateDoc);
    
    if (result.modifiedCount === 0) {
      return res.status(404).send({ message: "No changes made or recipe not found" });
    }

    res.status(200).send({ message: "Recipe updated successfully", result });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to update recipe", error: error.message });
  }
});


app.delete('/api/my-recipes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const query = { _id: new ObjectId(id) };
    
    const result = await recipescollection.deleteOne(query);
    
    if (result.deletedCount === 0) {
      return res.status(404).send({ message: "Recipe not found" });
    }

    res.status(200).send({ message: "Recipe deleted successfully", result });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to delete recipe", error: error.message });
  }
});



    app.get('/api/recipes', async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const search = req.query.search || '';
        const skip = (page - 1) * limit;
        
        let query = {};
        if (search) {
          query = {
            $or: [
              { recipeName: { $regex: search, $options: 'i' } },
              { cuisineType: { $regex: search, $options: 'i' } },
              { category: { $regex: search, $options: 'i' } }
            ]
          };
        }
        
        const [recipes, totalItems] = await Promise.all([
          recipescollection.find(query).skip(skip).limit(limit).toArray(),
          recipescollection.countDocuments(query)
        ]);
        
        res.status(200).send({
          recipes,
          totalItems,
          currentPage: page,
          totalPages: Math.ceil(totalItems / limit)
        });
      } catch (error) {
        console.error("Failed to fetch recipes:", error);
        res.status(500).send({ error: "Could not retrieve recipes." });
      }
    });

    app.get('/api/recipes/:id', async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ error: "Invalid recipe ID format" });
        }
        const query = { _id: new ObjectId(id) };
        const result = await recipescollection.findOne(query);
        if (!result) {
          return res.status(404).send({ error: "Recipe not found" });
        }
        res.status(200).send(result);
      } catch (error) {
        console.error("Failed to fetch recipe:", error);
        res.status(500).send({ error: "Could not retrieve recipe details." });
      }
    });


// ১. ফেভারিট লিস্টে যোগ করা অথবা অলরেডি থাকলে রিমুভ করা (Toggle Feature)
// এই লাইনটি ফাইলের একদম ওপরে নিশ্চিত করুন

// ==========================================
// ৮. ফেভারিট লিস্টে যোগ করা অথবা রিমুভ করা (POST) - FIXED
// ==========================================
app.post('/api/favorites', async (req, res) => {
  try {
    const { userId, recipeId } = req.body;
    
    if (!userId || !recipeId) {
      return res.status(400).send({ success: false, message: "userId and recipeId are required" });
    }

    // ✅ 'db' পরিবর্তন করে 'database' করা হলো
    const favoritesCollection = database.collection("favorites");

    // ডেটাবেজে খোঁজার জন্য অবজেক্ট তৈরি
    const query = { userId: userId, recipeId: recipeId };
    const existingFavorite = await favoritesCollection.findOne(query);

    if (existingFavorite) {
      // যদি অলরেডি থাকে, রিমুভ করবে
      await favoritesCollection.deleteOne(query);
      return res.status(200).send({ success: true, message: "Removed from favorites", isFavorite: false });
    } else {
      // যদি না থাকে, নতুন এড করবে
      await favoritesCollection.insertOne({ 
        userId, 
        recipeId, 
        createdAt: new Date() 
      });
      return res.status(201).send({ success: true, message: "Added to favorites", isFavorite: true });
    }
  } catch (error) {
    console.error("Favorite POST Error:", error);
    res.status(500).send({ success: false, message: "Server error occurred", error: error.message });
  }
});

// ==========================================
// ৯. ফেভারিট গেট রুট (GET) - FIXED
// ==========================================
app.get('/api/favorites/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // ✅ 'db' পরিবর্তন করে 'database' করা হলো
    const favoritesCollection = database.collection("favorites");

    // মঙ্গোডিবি Aggregation পাইপলাইন
    const userFavorites = await favoritesCollection.aggregate([
      { $match: { userId: userId } },
      {
        $addFields: {
          recipeObjectId: { $toObjectId: "$recipeId" } 
        }
      },
      {
        $lookup: {
          from: "recipes", 
          localField: "recipeObjectId",
          foreignField: "_id",
          as: "recipeDetails"
        }
      },
      { $unwind: { path: "$recipeDetails", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          userId: 1,
          recipeId: 1,
          recipeName: { $ifNull: ["$recipeDetails.recipeName", "Unknown Recipe"] },
          imageUrl: { $ifNull: ["$recipeDetails.imageUrl", ""] },
          category: { $ifNull: ["$recipeDetails.category", ""] },
          difficultyLevel: { $ifNull: ["$recipeDetails.difficultyLevel", ""] },
          cuisineType: { $ifNull: ["$recipeDetails.cuisineType", ""] }
        }
      }
    ]).toArray();

    res.status(200).send(userFavorites);
  } catch (error) {
    console.error("Favorite GET Error:", error);
    res.status(500).send([]);
  }
});








// মনে রাখবেন: এরপর নিচে আপনার app.post('/api/likes') এবং app.get('/api/likes/:userId') আগের মতোই থাকবে।

// ১. লাইক টগল করার রাউট (Like / Unlike)
// ১. লাইক টগল করার রাউট (Like / Unlike) - মঙ্গোডিবি নেটিভ ড্রাইভার দিয়ে সংশোধিত
app.post('/api/likes', async (req, res) => {
    try {
        const { userId, recipeId } = req.body;

        if (!userId || !recipeId) {
            return res.status(400).json({ success: false, message: "userId and recipeId are required!" });
        }

        // ডাটাবেজের 'likes' কালেকশনে চেক করা হচ্ছে
        const query = { userId, recipeId };
        const existingLike = await likesCollection.findOne(query);

        if (existingLike) {
            // যদি আগে থেকেই লাইক থাকে, তবে রিমুভ (Unlike) করা হবে
            await likesCollection.deleteOne(query);
            return res.status(200).json({ 
                success: true, 
                hasLiked: false, 
                message: "Removed from liked collection" 
            });
        } else {
            // যদি আগে লাইক না থাকে, তবে নতুন লাইক ইনসার্ট করা হবে
            await likesCollection.insertOne({
                userId,
                recipeId,
                createdAt: new Date()
            });
            return res.status(200).json({ 
                success: true, 
                hasLiked: true, 
                message: "Liked successfully" 
            });
        }
    } catch (error) {
        console.error("Error in POST /api/likes:", error);
        return res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});

// ২. কোনো নির্দিষ্ট ইউজারের সব লাইক করা রেসিপি গেট করার রাউট
// ২. কোনো নির্দিষ্ট ইউজারের সব লাইক করা রেসিপি গেট করার রাউট
app.get('/api/likes/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).json({ error: "User ID is required" });
        }

        // টোটাল লাইক লিস্ট অ্যারে আকারে ব্যাক করা হচ্ছে
        const userLikes = await likesCollection.find({ userId: userId }).toArray();
        
        return res.status(200).json(userLikes || []); 
    } catch (error) {
        console.error("Error in GET /api/likes/:userId:", error);
        return res.status(500).json([]); // এরর খেলেও ফাঁকা অ্যারে পাঠাবে যাতে ফ্রন্টএন্ড ক্র্যাশ না করে
    }
});



    // MongoDB Ping
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } catch (err) {
    console.error("Database connection failure:", err);
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});