# Marcell Isaiah Smith Inventory Site

This project displays Marcell's sales site and syncs vehicle data from Waxahachie Autoplex.

## First-time setup

1. Upload this entire project to the existing GitHub repository.
2. In GitHub, open **Actions**.
3. Choose **Sync Wax Inventory**.
4. Click **Run workflow**.
5. Wait for the workflow to finish. It will populate `inventory.json` and commit it to the repository.
6. Vercel will automatically redeploy the updated inventory.

The workflow also runs daily to keep inventory current.

Source: https://www.waxusedcars.com/sitemap.aspx
