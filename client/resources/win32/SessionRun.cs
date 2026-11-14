using System;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading.Tasks;

internal static partial class Sandbox
{
    internal static int RunSession(SessionOptions options)
    {
        IntPtr parent = ParentHandle(), job = IntPtr.Zero;
        Profile profile = null;
        List<Grant> grants = new List<Grant>();
        bool clean = true;
        string residualProfile = null;
        using (SessionWire wire = new SessionWire(options.Timeout)) {
            try {
                Action check = delegate { wire.Check(parent); };
                SecurityIdentifier capability = RuntimeCapability();
                byte[] capabilityBytes = new byte[capability.BinaryLength];
                capability.GetBinaryForm(capabilityBytes, 0);
                // Persistent read/execute ACE on the app-owned runtime for the named capability (added once per runtime).
                // Done before the profile exists, so a kill during the slow first grant cannot leak a profile.
                check(); EnsureRuntimeGrant(options.Root, capability, check);
                profile = new Profile();
                SecurityIdentifier sid = new SecurityIdentifier(profile.Sid);
                foreach (string work in options.Work) { check(); grants.Add(new Grant(work, sid, FileSystemRights.Modify, check)); }
                check(); job = CreateJob();
                wire.Emit(new { type = "ready", version = 1, profile = profile.Name, elapsedMs = wire.Clock.ElapsedMilliseconds });
                SessionLoop(options, profile.Sid, capabilityBytes, parent, job, wire);
            } catch (OperationCanceledException) { }
            catch (Exception error) {
                CleanupFailure failure = error as CleanupFailure;
                if (failure != null) { clean = false; residualProfile = failure.Profile; }
                Diagnostic("Session failure: " + FailureCode(error));
                wire.Cancel("error");
            }
            finally {
                clean = CleanupSession(profile, grants, job, wire, clean, residualProfile);
                CloseHandle(parent);
            }
            wire.Emit(new { type = "closed", reason = wire.Reason, cleanup = clean, elapsedMs = wire.Clock.ElapsedMilliseconds,
                profile = profile == null ? residualProfile : profile.Name });
            return !clean ? 125 : wire.Reason == "closed" ? 0 : wire.Reason == "timeout" ? 124 : 1223;
        }
    }
    internal static bool CleanupSession(Profile profile, List<Grant> grants, IntPtr job, SessionWire wire, bool clean, string residualProfile)
    {
        bool drained = job == IntPtr.Zero;
        if (job != IntPtr.Zero) {
            try { TerminateAndDrain(job, 125); drained = true; } catch (Exception) { clean = false; }
            CloseHandle(job);
        }
        // No job means setup failed/canceled before any engine could be launched.
        if (drained) {
            try { wire.Emit(new { type = "cleanup-start", stage = job == IntPtr.Zero ? "setup" : "session", activeProcesses = 0,
                profile = profile == null ? residualProfile : profile.Name, elapsedMs = wire.Clock.ElapsedMilliseconds }); }
            catch (Exception) { clean = false; }
        }
        foreach (Grant grant in grants) {
            try { grant.Dispose(); if (grant.CleanupError) clean = false; } catch (Exception) { clean = false; }
        }
        if (profile != null) {
            try { profile.Dispose(); if (profile.CleanupError) clean = false; } catch (Exception) { clean = false; }
        }
        return clean;
    }
    internal static void SessionLoop(SessionOptions options, IntPtr sid, byte[] capability, IntPtr parent, IntPtr job, SessionWire wire)
    {
        int previous = 0;
        while (true) {
            wire.Check(parent);
            Dictionary<string, object> request;
            if (!wire.Requests.TryTake(out request, Math.Min(50, wire.Remaining))) continue;
            if (Object.Equals(request["type"], "close")) return;
            Options invocation = Invocation(options, request);
            int id = (int)request["id"];
            if (id != previous + 1) throw new ArgumentException("Run sequence mismatch");
            previous = id;
            int exit = SessionLaunch(invocation, sid, capability, parent, job, wire, id, options.AllowChildren);
            wire.Check(parent);
            wire.Emit(new { type = "run-exit", id = id, code = exit, elapsedMs = wire.Clock.ElapsedMilliseconds });
        }
    }
    internal static int SessionLaunch(Options options, IntPtr sid, byte[] capability, IntPtr parent, IntPtr sessionJob, SessionWire wire, int id, bool allowChildren)
    {
        IntPtr runJob = CreateJob(allowChildren ? 8U : 1U);
        ProcessInfo process = new ProcessInfo();
        try {
            using (Pipe input = new Pipe(false))
            using (Pipe output = new Pipe(true))
            using (Pipe error = new Pipe(true))
            using (Attributes attributes = new Attributes(sid, capability, input.Child, output.Child, error.Child)) {
                wire.Check(parent); input.Parent.Dispose();
                Start(options, attributes, out process);
                Check(AssignProcessToJobObject(sessionJob, process.Process), "Assign session job");
                Check(AssignProcessToJobObject(runJob, process.Process), "Assign run job");
                if (ResumeThread(process.Thread) == UInt32.MaxValue) Check(false, "Resume session process");
                input.CloseChild(); output.CloseChild(); error.CloseChild();
                wire.Emit(new { type = "run-start", id = id, pid = process.Id });
                Task stdout = wire.Pump(output, id, "stdout"), stderr = wire.Pump(error, id, "stderr");
                uint wait = WaitForMultipleObjects(3, new IntPtr[] { process.Process, parent, wire.Stop.SafeWaitHandle.DangerousGetHandle() }, false, (uint)wire.Remaining);
                uint exit = 125;
                if (wait == 0) Check(GetExitCodeProcess(process.Process, out exit), "Read native exit");
                else wire.Cancel(wait == 1 ? "owner-exit" : wait == 258 ? "timeout" : wait == 2 ? wire.Reason : "error");
                TerminateAndDrain(runJob, exit);
                if (!Task.WaitAll(new Task[] { stdout, stderr }, 5000)) throw new TimeoutException("Run output did not close");
                wire.Check(parent); return unchecked((int)exit);
            }
        } finally {
            TerminateJobObject(runJob, 125);
            if (process.Process != IntPtr.Zero) { TerminateProcess(process.Process, 125); CloseHandle(process.Process); }
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            CloseHandle(runJob);
        }
    }
}
