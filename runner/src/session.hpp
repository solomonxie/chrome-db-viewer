// A Session is one worker thread with a FIFO job queue and the driver it runs jobs against.
// libpq and hiredis connections aren't thread safe, so every call on a connection happens
// on its session's worker. `cancel` comes from the stdin reader thread: it flags the job's
// CancelToken and interrupts the driver (PQcancel, socket shutdown) so it isn't stuck
// behind the job it cancels. See design/DESIGN.md §3.4.
#pragma once

#include <condition_variable>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "drivers/driver.hpp"

namespace dbui {

class Session {
 public:
  using Work = std::function<void(CancelToken&)>;
  /** Called (on the reader thread) for a queued job that was cancelled before it started. */
  using OnSkipped = std::function<void(long long id)>;

  explicit Session(std::string name, OnSkipped onSkipped = {});
  ~Session();
  Session(const Session&) = delete;
  Session& operator=(const Session&) = delete;

  void start();
  /** Cancels the running job, drops queued ones and joins the worker. Idempotent. */
  void stop();

  void submit(long long id, Work work);

  /** Cancels job `target` if it is queued or running. Returns false if no such job. */
  bool cancel(long long target);

  /** Driver access. Only the worker thread may call driver() or setDriver(). */
  Driver* driver() const { return driver_.get(); }
  void setDriver(std::unique_ptr<Driver> d);

 private:
  struct Job {
    long long id;
    Work work;
    std::shared_ptr<CancelToken> token;
  };
  void loop();

  std::string name_;
  OnSkipped onSkipped_;
  std::mutex mu_;
  std::condition_variable cv_;
  std::deque<Job> queue_;
  bool stopping_ = false;
  long long runningId_ = -1;
  std::shared_ptr<CancelToken> runningToken_;
  std::mutex driverMu_;  // guards swapping driver_ against cancel() reading it
  std::unique_ptr<Driver> driver_;
  std::thread thread_;
};

}  // namespace dbui
