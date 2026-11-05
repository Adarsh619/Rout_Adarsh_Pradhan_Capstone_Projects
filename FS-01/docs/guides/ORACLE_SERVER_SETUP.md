# Oracle Cloud server for ShopSphere: step-by-step checklist

[Index](../README.md) · [10-day build tracker](DAY_PLAN.md)

This creates ShopSphere's **own** Always Free ARM server in Oracle Cloud. Later (Day 9) it will run the API, worker,
Redis, Elasticsearch and Caddy (HTTPS). It is **separate from every other project**: its own compartment, its own
network, its own SSH key and its own server.

**How to use this page:** do the steps in order and tick each box (`[x]`). Every step says
**Where** to look, **Do** (what to click or type) and **Check** (what you should see before moving on).
Parts A–F take about 30–40 minutes. **Part G is for Day 9; don't do it yet.**

> **Never share** the private key file `shopsphere_oci` (the one **without** `.pub`), your Oracle password or any
> API keys. Sharing the server's public IP address is fine.
>
> **Leave other projects alone.** You will see `taskflow-vcn` (FS-04's network) on the home page and in lists.
> Don't open, edit or delete it, and never pick it in any drop-down below.

### Words you'll see

| Word | Meaning |
|---|---|
| **Tenancy** | Your whole Oracle Cloud account |
| **Home region** | The data centre your account belongs to. Yours is **India South (Hyderabad)** |
| **Compartment** | A folder that groups resources. We create one called `shopsphere` |
| **VCN** (virtual cloud network) | A private network for your servers, like a home Wi-Fi network in the cloud |
| **Subnet** | A part of the VCN. *Public* subnets can be reached from the internet |
| **Security list** | The VCN's firewall: which ports are allowed in |
| **Instance** | A server (virtual machine) |
| **Shape** | The server's size: how many CPUs (**OCPUs**) and how much memory |
| **OCPU** | One CPU core |
| **Boot volume** | The server's hard disk |
| **SSH key** | A pair of files that lets you log in without a password: the **private** key stays on your PC, the **public** key (`.pub`) goes to the server |

### The navigation menu

Most steps start from the **navigation menu**: the **☰ icon (three lines) at the top-left corner** of every Oracle
page. Clicking it opens a list of services (Compute, Networking, Identity & Security, …). Clicking a service name
shows its sub-pages on the right.

If you get lost at any point: click the **Oracle Cloud logo** at the top-left to return to the home page you saw.

---

## Part A · Before you start (5 minutes)

### A1 · Confirm your home region
- [ ] **Where:** top-right corner of the page, the **profile icon** (a person outline or your initials), the right-most icon.
- [ ] **Do:** click it. In the menu that opens, click the line that starts with **Tenancy:** (followed by your tenancy name).
- [ ] **Check:** the **Tenancy details** page opens. Find the field **Home region**. It should say **India South (Hyderabad)** (or similar, e.g. `ap-hyderabad-1`).
- [ ] Write it down: `Home region = ______________________`

### A2 · Make sure you're working in the home region
- [ ] **Where:** top bar, just left of the profile icon: the **region selector**, which shows a region name (e.g. *India South (Hyderabad)*) with a small down-arrow.
- [ ] **Do:** if it shows a different region, click it and choose your home region from A1.
- [ ] **Check:** the top bar now shows **India South (Hyderabad)**. Your home page's Resources box already showed this region, so it's most likely correct.
- *Why:* Always Free ARM servers can only be created in the home region. Creating them anywhere else costs money.

### A3 · Check the free allowance isn't already used by other servers
The free ARM allowance is **4 OCPUs and 24 GB memory in total** and **200 GB of disk in total**, across all your
projects. ShopSphere needs **2 OCPUs, 12 GB and 50 GB**.

- [ ] **Where:** navigation menu **☰** → **Compute** → **Instances**.
- [ ] **Do:** on the left side of the Instances page there is a **Compartment** drop-down (sometimes under **List scope**). Open it and look at each compartment in turn, starting with the **root** one (it has your tenancy name and "(root)").
- [ ] **Check:** write down any existing instances whose **Shape** is `VM.Standard.A1.Flex`, with their OCPUs and memory:

  | Instance name | Compartment | OCPUs | Memory (GB) |
  |---|---|---|---|
  | | | | |

  **Total used must be at most 2 OCPUs and 12 GB**, so ShopSphere's 2 + 12 still fits. If you see **no instances**, you have the full allowance.
- [ ] **Where:** navigation menu **☰** → **Storage** → **Block Storage** → **Boot Volumes** (check the same compartments).
- [ ] **Check:** existing boot volumes **and** block volumes (**☰ → Storage → Block Storage → Block Volumes**) add up to **at most 150 GB**, so ShopSphere's 50 GB still fits. No volumes listed = 0 GB used.
- [ ] **Don't** change or delete anything you find there.

---

## Part B · Compartment and network (10 minutes)

### B1 · Create the `shopsphere` compartment
- [ ] **Where:** navigation menu **☰** → **Identity & Security** → under **Identity**, click **Compartments**.
- [ ] **Check:** a list of compartments opens. You'll see your root compartment and maybe others; leave them alone.
- [ ] **Do:** click the **Create Compartment** button (above the list).
- [ ] **Do:** in the panel that slides in, fill in:

  | Field | Type or choose |
  |---|---|
  | **Name** | `shopsphere` |
  | **Description** | `FS-01 ShopSphere multi-vendor marketplace` |
  | **Parent Compartment** | your **root** compartment (your tenancy name, marked "(root)"). It's usually selected already |
  | **Tags** | leave empty |

- [ ] **Do:** click **Create Compartment** at the bottom of the panel.
- [ ] **Check:** `shopsphere` appears in the list with state **Active**.
- [ ] **Wait 1–2 minutes** before the next step: new compartments take a moment to appear in other drop-downs. If `shopsphere` is missing in a drop-down later, refresh the page.

### B2 · Create the network `shopsphere-vcn`
Your home page has a shortcut for this: in the **Build** box on the right, **Networking → Set up a network with a wizard**.
Either use that, or the menu route below. Both open the same wizard.

- [ ] **Where:** navigation menu **☰** → **Networking** → **Virtual cloud networks**.
- [ ] **Do:** on the left, in the **Compartment** drop-down (under **List scope**), choose **`shopsphere`**.
- [ ] **Check:** the list is empty ("No items found"). You will **not** see `taskflow-vcn` here, because that's in another compartment. That's correct.
- [ ] **Do:** click **Start VCN Wizard** (it may be a button on its own, or inside an **Actions** button).
- [ ] **Do:** a box with two options appears. Choose **Create VCN with Internet Connectivity** (not "Add Internet Connectivity and Site-to-Site VPN"). Click **Start VCN Wizard** at the bottom.
- [ ] **Do:** on the **Configuration** page fill in:

  | Field | Type or choose |
  |---|---|
  | **VCN name** | `shopsphere-vcn` |
  | **Compartment** | `shopsphere` (**check this**; don't leave it on root) |
  | **VCN IPv4 CIDR blocks** | leave the default (`10.0.0.0/16`) |
  | **Enable IPv6** | leave **off** |
  | **Use DNS hostnames in this VCN** | leave **on** (default) |
  | **Public Subnet IPv4 CIDR Block** | leave the default (`10.0.0.0/24`) |
  | **Private Subnet IPv4 CIDR Block** | leave the default (`10.0.1.0/24`) |

- [ ] **Do:** click **Next**. A **Review** page lists what will be created (VCN, public subnet, private subnet, internet gateway, NAT gateway, service gateway, route tables, security lists).
- [ ] **Do:** click **Create**.
- [ ] **Check:** a progress page fills with green ticks. When everything is ticked, click **View VCN** (or **View Virtual Cloud Network**).
- [ ] **Check:** the VCN page shows **Name `shopsphere-vcn`**, **State Available**, **Compartment `shopsphere`**.

### B3 · Open the web ports 80 and 443
These let visitors reach the website later. SSH (port 22) is already open by default.

- [ ] **Where:** on the `shopsphere-vcn` page, find **Subnets**. Depending on the layout it's a **tab** across the top of the page or a link in the **Resources** list on the left.
- [ ] **Do:** click **public subnet-shopsphere-vcn**. (Not the private one.)
- [ ] **Check:** the subnet page says **Subnet access: Public**.
- [ ] **Do:** find **Security Lists** (tab, or Resources list) and click **Default Security List for shopsphere-vcn**.
- [ ] **Do:** find **Ingress Rules** (tab, or **Security rules** → Ingress) and click **Add Ingress Rules**.
- [ ] **Do:** fill in **rule 1**:

  | Field | Type or choose |
  |---|---|
  | **Stateless** | leave **unticked** |
  | **Source Type** | **CIDR** |
  | **Source CIDR** | `0.0.0.0/0` |
  | **IP Protocol** | **TCP** |
  | **Source Port Range** | leave empty (means "All") |
  | **Destination Port Range** | `80` |
  | **Description** | `HTTP for Caddy (redirects to HTTPS)` |

- [ ] **Do:** click **+ Another Ingress Rule** (under rule 1) and fill in **rule 2** the same way, except:
  **Destination Port Range** `443`, **Description** `HTTPS for Caddy`.
- [ ] **Do:** click **Add Ingress Rules** at the bottom.
- [ ] **Check:** the Ingress Rules list now contains:

  | Source | Protocol | Destination port |
  |---|---|---|
  | 0.0.0.0/0 | TCP | 22 (was already there) |
  | 0.0.0.0/0 | TCP | **80** |
  | 0.0.0.0/0 | TCP | **443** |
  | (two or three ICMP rules) | ICMP | — (were already there; leave them) |

- [ ] **Don't** add any other ports. MongoDB, Redis and Elasticsearch must never be open to the internet.

---

## Part C · Make the SSH key on your PC (5 minutes)

Open **PowerShell**: press the **Windows key**, type `PowerShell`, press **Enter**. Paste each command, press **Enter**,
and check the result before the next one.

- [ ] **C1.** Make sure the `.ssh` folder exists (safe to run even if it already does):
  ```powershell
  New-Item -ItemType Directory -Force "$HOME\.ssh" | Out-Null
  ```
  **Check:** no output, no red text.

- [ ] **C2.** Create the key pair:
  ```powershell
  ssh-keygen -t ed25519 -f "$HOME\.ssh\shopsphere_oci" -C shopsphere-oci
  ```
  - If you see **`Overwrite (y/n)?`** → type `n`, press Enter, and tell me (a key with this name already exists; don't overwrite it).
  - At **`Enter passphrase (empty for no passphrase):`** → just press **Enter**.
  - At **`Enter same passphrase again:`** → press **Enter** again.

  **Check:** it prints `Your identification has been saved in …\.ssh\shopsphere_oci` and a small picture made of characters.

- [ ] **C3.** Check both files exist:
  ```powershell
  Get-ChildItem "$HOME\.ssh\shopsphere_oci*"
  ```
  **Check:** two files: `shopsphere_oci` (private, **keep secret**) and `shopsphere_oci.pub` (public).

- [ ] **C4.** Copy the **public** key to the clipboard:
  ```powershell
  Get-Content "$HOME\.ssh\shopsphere_oci.pub" | Set-Clipboard
  ```
  **Check (optional):** paste into Notepad: it's **one line** starting `ssh-ed25519` and ending `shopsphere-oci`. Close Notepad without saving.

Keep PowerShell open; you'll use it again in Part F.

---

## Part D · Create the server (10 minutes)

Your home page also has a shortcut: **Build** box → **Compute → Create a VM instance**. Either use that, or:

- [ ] **D1. Where:** navigation menu **☰** → **Compute** → **Instances**.
- [ ] **D2. Do:** set the **Compartment** drop-down on the left to **`shopsphere`**. **Check:** the list is empty.
- [ ] **D3. Do:** click **Create instance**.

The form is one long page (or a few steps: **Basic information → Security → Networking → Storage → Review**).
The order may differ slightly; the fields are the same.

### Basic information
- [ ] **D4. Name:** clear the suggested name (like `instance-20261103-…`) and type `shopsphere-api`.
- [ ] **D5. Create in compartment:** **`shopsphere`**.
- [ ] **D6. Placement → Availability domain:** leave the default (Hyderabad has one, **AD-1**). Leave **Capacity type** on **On-demand capacity** and **Fault domain** on the default ("Let Oracle choose").

### Image and shape: change the **shape first**, then the image
- [ ] **D7. Shape.** In the **Image and shape** section, click **Change shape** (on some layouts first click **Edit** on that section).
  A panel **Browse all shapes** opens:
  - **Instance type:** click **Virtual machine**.
  - **Shape series:** click **Ampere** (ARM processors).
  - In the list, tick **VM.Standard.A1.Flex**. It has an **Always Free-eligible** label.
  - Under it, set **Number of OCPUs** to `2` and **Amount of memory (GB)** to `12`. (Network bandwidth fills in by itself.)
  - Click **Select shape** at the bottom.
  - **Check:** the section now says **VM.Standard.A1.Flex · 2 OCPU · 12 GB memory** and **Always Free-eligible**.
- [ ] **D8. Image.** In the same section, click **Change image**. A panel **Select an image** opens:
  - Click the **Ubuntu** tile.
  - In the list, tick **Canonical Ubuntu 24.04** (the normal one; **not** "Canonical Ubuntu 24.04 Minimal").
  - **Check:** the **Image build** shown for it ends in **aarch64** (ARM). If you click the small down-arrow next to the image you can see the build; the newest is selected automatically.
  - Click **Select image**.
  - **Check:** the section now shows **Canonical Ubuntu 24.04** and **VM.Standard.A1.Flex**.

### Security
- [ ] **D9.** Leave everything here at the defaults (**Shielded instance** off, no confidential computing).

### Networking
- [ ] **D10. VNIC name:** leave empty.
- [ ] **D11. Primary network:** choose **Select existing virtual cloud network**.
  - **Virtual cloud network compartment:** `shopsphere`
  - **Virtual cloud network:** **`shopsphere-vcn`** (never `taskflow-vcn`)
- [ ] **D12. Subnet:** choose **Select existing subnet**.
  - **Subnet compartment:** `shopsphere`
  - **Subnet:** **public subnet-shopsphere-vcn (regional)**
- [ ] **D13. Private IPv4 address:** leave **Automatically assign private IPv4 address**.
- [ ] **D14. Public IPv4 address:** make sure **Automatically assign public IPv4 address** is **ticked**.
  **Check:** if this option is missing, you picked the private subnet; go back to D12.
- [ ] **D15.** Leave IPv6, DNS record and advanced options at their defaults.

### Add SSH keys
- [ ] **D16.** Choose **Paste public keys** (not "Generate a key pair for me", not "No SSH keys").
- [ ] **D17.** Click in the **SSH keys** box and press **Ctrl+V**.
  **Check:** the box shows one line starting `ssh-ed25519` and ending `shopsphere-oci`. If it shows anything else, run C4 again and re-paste.

### Storage (boot volume)
- [ ] **D18.** Tick **Specify a custom boot volume size**.
- [ ] **D19.** **Boot volume size (GB):** `50`. ShopSphere needs about 15–20 GB (Ubuntu, Docker images, Elasticsearch data, logs), so 50 GB leaves plenty of room. A boot volume **can be enlarged later without losing data, but never shrunk**, so starting small is the safe choice and keeps free storage for other projects.
- [ ] **D20.** **Boot volume performance:** leave **Balanced** (default, about 10 VPUs/GB).
- [ ] **D21.** Leave **Use in-transit encryption** as it is, and **don't** tick "Encrypt this volume with a key that you manage".
- [ ] **D22.** Don't add any extra block volumes.

### Review and create
- [ ] **D23.** On the **Review** step (or the summary on the right), check every line:

  | Item | Must be |
  |---|---|
  | Name | `shopsphere-api` |
  | Compartment | `shopsphere` |
  | Shape | VM.Standard.A1.Flex · 2 OCPU · 12 GB · **Always Free-eligible** |
  | Image | Canonical Ubuntu 24.04 (aarch64) |
  | VCN / subnet | `shopsphere-vcn` / public subnet |
  | Public IPv4 | assigned automatically |
  | SSH key | 1 key |
  | Boot volume | 50 GB, Balanced |

  **About "View estimated cost":** it should show **no line for the instance itself** (the A1.Flex shape is recognised as Always Free).
  It **will** show a **Boot volume** price (about **$3/month** for 50 GB, **$5–6/month** for 100 GB). That's expected: the estimator uses list prices and
  "does not reflect any tier unit pricing", so it ignores the **200 GB of free block storage**. As long as all your boot and block
  volumes together stay at or under 200 GB (checked in A3), the disk is free. If the **instance** line shows a price, recheck D7.
- [ ] **D24.** Click **Create**.
- [ ] **D25. Check:** the instance page opens with a big status icon: **PROVISIONING** (orange) → **RUNNING** (green), usually within 1–3 minutes. Refresh the page if it seems stuck.

If instead you see a red message like **"Out of capacity for shape VM.Standard.A1.Flex"** or **"Out of host capacity"**, go to Part E.

---

## Part E · If it says "Out of host capacity"

This is common for free ARM servers and isn't your mistake. Try in this order:

- [ ] **E1.** Wait a minute and click **Create** again (the form keeps your entries).
- [ ] **E2. Create smaller, then grow:**
  1. On the same form, go back to **D7** and set **1 OCPU** and **6 GB** memory → **Create**.
  2. When it's **RUNNING**, on the instance page click **More actions** (or **Actions**) → **Edit**.
  3. Open **Edit shape** → set **2 OCPUs** and **12 GB** → **Save changes**. The server reboots, which takes a few minutes.
  4. If the resize also says out of capacity, keep 1 OCPU / 6 GB for now. That's enough until Day 9; try the resize again another day.
- [ ] **E3.** Try at a different time of day; early morning or late night India time is often better.
- [ ] **E4.** Don't upgrade to **Pay As You Go** just to get capacity unless you're comfortable with a card on file. If you ever do, first set a budget alert: **☰ → Billing & Cost Management → Budgets → Create Budget**.
- [ ] **E5.** If it still fails by **Day 8 (Mon 9 Nov)**, tell me and we'll use the fallback: the same Docker setup on an AWS EC2 t4g.small in Mumbai (design decision 10).

---

## Part F · Check it works (5 minutes)

### F1 · Note the server details
- [ ] **Where:** **☰ → Compute → Instances** → compartment `shopsphere` → click **shopsphere-api**.
- [ ] On the **Instance details** page, note:

  | Field | Value |
  |---|---|
  | **Instance access → Public IP address** (or **Primary VNIC → Public IPv4 address**) | `____.____.____.____` |
  | **Shape** | VM.Standard.A1.Flex |
  | **OCPU count / Memory** | 2 / 12 GB (or 1 / 6 GB, see Part E) |
  | **Image** | Canonical-Ubuntu-24.04-aarch64-… |
  | **Region / Availability domain** | ap-hyderabad-1 / AD-1 |

### F2 · Log in with SSH (PowerShell)
- [ ] Run this, replacing `<PUBLIC_IP>` with the IP from F1 (no `<` `>`):
  ```powershell
  ssh -i "$HOME\.ssh\shopsphere_oci" ubuntu@<PUBLIC_IP>
  ```
- [ ] The first time it asks **`Are you sure you want to continue connecting (yes/no/[fingerprint])?`** → type `yes` → Enter.
- [ ] **Check:** a welcome text from Ubuntu, then a prompt like **`ubuntu@shopsphere-api:~$`**. You're on the server.

### F3 · Quick checks on the server
Type each command at the `ubuntu@shopsphere-api:~$` prompt and compare:

- [ ] `uname -m` → **`aarch64`**
- [ ] `nproc` → **`2`**
- [ ] `free -h` → the **Mem:** row's **total** is about **`11Gi`–`12Gi`**
- [ ] `df -h /` → **Size** about **`48G`**
- [ ] `lsb_release -d` → **`Ubuntu 24.04…`**
- [ ] `exit` → back to your PC's PowerShell prompt.

### F4 · If SSH doesn't connect

| What you see | What to do |
|---|---|
| `Connection timed out` | The instance isn't **RUNNING** yet; or it's in the **private** subnet; or it has no **public IP** (D12–D14). Check that port 22 is in the security list (B3) |
| `Permission denied (publickey)` | The user must be **`ubuntu`**, and `-i` must point to **`shopsphere_oci`** (no `.pub`). If the wrong key was pasted in D17, the console can't swap it afterwards: tell me and we'll fix it (usually by re-creating the instance) |
| `WARNING: UNPROTECTED PRIVATE KEY FILE!` | Run `icacls "$HOME\.ssh\shopsphere_oci" /inheritance:r /grant:r "$($env:USERNAME):R"` then try again |
| `REMOTE HOST IDENTIFICATION HAS CHANGED` | Only after re-creating a server with the same IP: run `ssh-keygen -R <PUBLIC_IP>` then try again |
| `ssh` is not recognised | Windows' OpenSSH client is missing: **Settings → System → Optional features → Add a feature → OpenSSH Client** |

---

## Part G · Stop here (Day 9 continues from this point)

**Don't install anything on the server yet.** On Day 9 we'll do these together:
1. System updates.
2. Open ports 80 and 443 in **Ubuntu's own firewall** (Oracle's Ubuntu images block them even though the security list allows them).
3. Install Docker and Docker Compose.
4. Set `vm.max_map_count=262144` for Elasticsearch.
5. A free DuckDNS name pointing at the IP, and Caddy for automatic HTTPS.
6. A `deploy` user and key for the CI deploy job.
7. Deploy ShopSphere and connect UptimeRobot.

## Tell me when done

Send: ✅ **RUNNING**, the **shape** (2/12 or 1/6), and whether **SSH worked**. The IP is optional.
I'll tick the Oracle item in the [tracker](DAY_PLAN.md).
