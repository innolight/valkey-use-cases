# ValKey Use Cases

This project demonstrates different ways to use ValKey for various use cases.

The implemented use cases is exposed via REST APIs impletemend in Nodejs.

1. [Caching](/apps/caching/) 📦: Store the results of expensive operations (like database queries or API calls) to serve future requests much faster.

2. Session Store 👤: Manage user login sessions and temporary user data without overloading your primary database.

3. [Rate Limiter](/apps/rate-limiter/) 🚦: Restrict the number of times an action can be performed within a specific time window to prevent abuse.

4. Leaderboard 🏆: Maintain real-time, ordered lists of users or items based on scores, perfect for gaming and contests.

5. Pub/Sub Messaging 📢: Create a real-time messaging system where publishers send messages to subscribers through channels.

6. Job & Message Queue ⚙️: Offload long-running tasks to background workers to improve application responsiveness.

7. Real-time Analytics 📈: Count events at massive scale (like clicks or views) instantly without hitting a slow database.

8. Geospatial Indexing 🗺️: Store and query data based on geographic coordinates to find points of interest within a specific radius.

9. [Distributed Lock](/apps/distributed-lock/) 🔒: Ensure only one process in a distributed system can access a critical resource at a time.
